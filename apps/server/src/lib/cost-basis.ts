import type { Database } from "bun:sqlite";
import { canonicalSymbol } from "./symbolAliases";

// Stablecoins are excluded from FIFO — basis = face value, always.
const STABLECOINS = new Set(["USDC", "USDT", "DAI", "BUSD", "USD"]);

export interface FifoResult {
  qty: number;
  basis: number;
  /** First acquisition date of any lot still in the queue. */
  earliest_lot_date: string | null;
}

interface Lot {
  qty: number;
  cost: number;
  date: string;
}

/** Canonicalize a CoinTracker currency symbol. No chain / contract info
 * in CoinTracker rows, so symbol-only lookup — close enough for the
 * common case (WETH → ETH, stETH → ETH, USDC.e → USDC). */
function canon(sym: string): string {
  return canonicalSymbol(sym).toUpperCase();
}

type Source = "ct" | "derived";

type BasisEvent =
  | { kind: "acq"; src: Source; sym: string; date: string; qty: number; cost: number }
  | { kind: "disp"; src: Source; sym: string; date: string; qty: number };

/** FIFO cost basis per canonical symbol, computed from CoinTracker raw_events
 * augmented by on-chain DEX swaps reconstructed in `derived_cost_basis_events`.
 *
 * Walk in chronological order, per-symbol:
 *   - Acquisition → push lot {qty, cost} onto the FIFO queue.
 *   - Disposal → consume qty from the front of the queue.
 *
 * Remaining lots = currently-held qty and basis. If disposals exceed recorded
 * acquisitions (an acquisition we never saw — e.g. a DEX swap in an Alchemy
 * wallet that also went through CoinTracker for part of its life), we clamp
 * to empty rather than go negative.
 *
 * Double-count guard: derived events are ignored when their tx_hash already
 * appears in CoinTracker (CoinTracker exports a `Transaction Hash` per row).
 * Per-symbol filtering was too blunt — wallets often partially overlap, and
 * a single tiny spam airdrop of DEGEN in a CT-tracked wallet would otherwise
 * mask a real 100M-token acquisition in a DEX-only wallet.
 *
 * Output is keyed by canonical symbol (ETH, not WETH). */
export function computeCryptoBasisFifo(db: Database): Map<string, FifoResult> {
  const ctRows = db
    .prepare(
      `SELECT
         json_extract(payload, '$.Date') AS date,
         json_extract(payload, '$.Received Currency') AS recv_cur,
         CAST(json_extract(payload, '$.Received Quantity') AS REAL) AS recv_qty,
         CAST(json_extract(payload, '$.Received Cost Basis (USD)') AS REAL) AS recv_basis,
         json_extract(payload, '$.Sent Currency') AS sent_cur,
         CAST(json_extract(payload, '$.Sent Quantity') AS REAL) AS sent_qty,
         LOWER(json_extract(payload, '$."Transaction Hash"')) AS tx_hash
       FROM raw_events
       WHERE source = 'cointracker'
       ORDER BY json_extract(payload, '$.Date') ASC, id ASC`,
    )
    .all() as Array<{
      date: string | null;
      recv_cur: string | null;
      recv_qty: number | null;
      recv_basis: number | null;
      sent_cur: string | null;
      sent_qty: number | null;
      tx_hash: string | null;
    }>;

  const events: BasisEvent[] = [];
  const ctTxHashes = new Set<string>();
  for (const r of ctRows) {
    if (r.tx_hash) ctTxHashes.add(r.tx_hash);
    if (r.recv_cur && r.recv_qty && r.recv_qty > 0) {
      const sym = canon(r.recv_cur);
      if (!STABLECOINS.has(sym)) {
        events.push({
          kind: "acq",
          src: "ct",
          sym,
          date: r.date ?? "",
          qty: r.recv_qty,
          cost: Math.max(0, r.recv_basis ?? 0),
        });
      }
    }
    if (r.sent_cur && r.sent_qty && r.sent_qty > 0) {
      const sym = canon(r.sent_cur);
      if (!STABLECOINS.has(sym)) {
        events.push({
          kind: "disp",
          src: "ct",
          sym,
          date: r.date ?? "",
          qty: r.sent_qty,
        });
      }
    }
  }

  const derRows = db
    .prepare(
      `SELECT
         LOWER(tx_hash) AS tx_hash,
         occurred_at AS date,
         received_symbol, received_quantity,
         sent_symbol,     sent_quantity,
         cost_basis_usd,  proceeds_usd
       FROM derived_cost_basis_events
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all() as Array<{
      tx_hash: string | null;
      date: string | null;
      received_symbol: string | null;
      received_quantity: number | null;
      sent_symbol: string | null;
      sent_quantity: number | null;
      cost_basis_usd: number | null;
      proceeds_usd: number | null;
    }>;

  for (const r of derRows) {
    if (r.tx_hash && ctTxHashes.has(r.tx_hash)) continue;
    // Acquisition: cost_basis_usd set ⇒ received side is a single new lot.
    if (
      r.cost_basis_usd != null &&
      r.received_symbol &&
      r.received_quantity &&
      r.received_quantity > 0
    ) {
      const sym = canon(r.received_symbol);
      if (!STABLECOINS.has(sym)) {
        events.push({
          kind: "acq",
          src: "derived",
          sym,
          date: r.date ?? "",
          qty: r.received_quantity,
          cost: Math.max(0, r.cost_basis_usd),
        });
      }
    }
    // Disposal: proceeds_usd set ⇒ sent side is a single disposal.
    if (
      r.proceeds_usd != null &&
      r.sent_symbol &&
      r.sent_quantity &&
      r.sent_quantity > 0
    ) {
      const sym = canon(r.sent_symbol);
      if (!STABLECOINS.has(sym)) {
        events.push({
          kind: "disp",
          src: "derived",
          sym,
          date: r.date ?? "",
          qty: r.sent_quantity,
        });
      }
    }
  }

  // Chronological merge per source. Sources walk independently because they
  // represent disjoint wallet sets — a CT sell disposes CT-wallet lots, and
  // must not drain a derived-wallet lot that happens to share a symbol.
  // The tx_hash dedup above means a given swap is in exactly one source.
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const queues = new Map<string, { ct: Lot[]; derived: Lot[] }>();
  const ensure = (sym: string) => {
    let q = queues.get(sym);
    if (!q) {
      q = { ct: [], derived: [] };
      queues.set(sym, q);
    }
    return q;
  };

  const EPS = 1e-9;

  for (const e of events) {
    const q = ensure(e.sym)[e.src];
    if (e.kind === "acq") {
      q.push({ qty: e.qty, cost: e.cost, date: e.date });
      continue;
    }
    let remaining = e.qty;
    while (remaining > EPS && q.length > 0) {
      const head = q[0];
      if (head.qty <= remaining + EPS) {
        remaining -= head.qty;
        q.shift();
      } else {
        const frac = remaining / head.qty;
        head.cost = head.cost * (1 - frac);
        head.qty -= remaining;
        remaining = 0;
      }
    }
    // remaining > 0 ⇒ disposal larger than our books; leave queue empty.
  }

  const out = new Map<string, FifoResult>();
  for (const [sym, q] of queues) {
    const all = [...q.ct, ...q.derived];
    const qty = all.reduce((s, l) => s + l.qty, 0);
    const basis = all.reduce((s, l) => s + l.cost, 0);
    if (qty <= EPS) continue;
    const earliest = all.reduce<string | null>(
      (e, l) => (e == null || (l.date && l.date < e) ? l.date || e : e),
      null,
    );
    out.set(sym, { qty, basis, earliest_lot_date: earliest });
  }
  return out;
}

export interface BasisMatch {
  /** Cost basis in USD, or null when CoinTracker coverage is too thin. */
  basis: number | null;
  /** Fraction of live qty covered by the FIFO queue, in [0,1]. */
  coverage: number;
}

/** Minimum FIFO coverage required before we report any basis at all.
 * Below this, CoinTracker's view of the position is so out of sync with
 * the live wallet that any extrapolation would be noise — better to say
 * "basis unknown" than to claim a $0 basis on a $1k holding. */
const MIN_COVERAGE = 0.1;

/** Match a FIFO basis result to a live holding quantity.
 *
 * When FIFO qty >= live qty, the queue fully covers the holding — return
 * per-unit avg price × live qty. When FIFO qty < live qty, CoinTracker
 * missed some acquisitions (e.g. on-chain DEX swap in a wallet that wasn't
 * imported); return basis only for the covered portion at per-unit price,
 * and surface `coverage` so the UI can flag partial basis.
 *
 * If coverage falls below MIN_COVERAGE, returns { basis: null } — the
 * holding needs a manual override or on-chain reconstruction instead. */
export function matchBasisToHolding(
  fifo: FifoResult,
  liveQty: number,
): BasisMatch {
  if (fifo.qty <= 0 || liveQty <= 0) return { basis: null, coverage: 0 };
  const coveredQty = Math.min(liveQty, fifo.qty);
  const coverage = coveredQty / liveQty;
  if (coverage < MIN_COVERAGE) return { basis: null, coverage };
  const pricePerUnit = fifo.basis / fifo.qty;
  return { basis: pricePerUnit * coveredQty, coverage };
}
