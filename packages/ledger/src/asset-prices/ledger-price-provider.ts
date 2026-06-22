import type { Database } from "bun:sqlite";
import type { PriceProvider, PriceLookup, PriceProviderArgs } from "@coffer/parsers";

export interface LedgerPriceProviderOpts {
  /**
   * Lower index = higher priority. When multiple rows match the same
   * (chain, contract_address, symbol, as_of), the source with the
   * lowest index wins. Sources not listed sort last in their natural order.
   */
  sourcePriority?: string[];
  /**
   * Maximum |Δdays| from the requested as_of to consider when no exact
   * match is found. Set to 0 to disable nearest-neighbor lookup.
   */
  nearestNeighborDays?: number;
}

const DEFAULT_SOURCE_PRIORITY = [
  "defillama",
  "coingecko",
  "yfinance",
  "geckoterminal",
  "zerion",
  "alchemy",
  "manual",
];

const DEFAULT_NEAREST_NEIGHBOR_DAYS = 7;

interface PriceRow {
  chain: string;
  contract_address: string;
  symbol: string;
  as_of: string;
  source: string;
  price_usd: number;
}

function daysBetween(a: string, b: string): number {
  // a and b are YYYY-MM-DD. Parse as UTC midnights.
  const ta = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const tb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.abs(ta - tb) / 86_400_000;
}

function priorityIndex(priority: string[], source: string): number {
  const i = priority.indexOf(source);
  return i < 0 ? priority.length : i;
}

/** Pick the best row from a list using:
 *  1. Lowest |Δ as_of| from target date
 *  2. Tiebreak by source priority
 *  3. Tiebreak by source name (stable for tests)
 */
function pickBest(rows: PriceRow[], targetDate: string, priority: string[]): PriceRow {
  let best = rows[0]!;
  let bestDelta = daysBetween(best.as_of, targetDate);
  let bestPrio = priorityIndex(priority, best.source);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const delta = daysBetween(r.as_of, targetDate);
    const prio = priorityIndex(priority, r.source);
    if (
      delta < bestDelta ||
      (delta === bestDelta && prio < bestPrio) ||
      (delta === bestDelta && prio === bestPrio && r.source < best.source)
    ) {
      best = r;
      bestDelta = delta;
      bestPrio = prio;
    }
  }
  return best;
}

export class LedgerPriceProvider implements PriceProvider {
  private readonly priority: string[];
  private readonly windowDays: number;

  constructor(
    private readonly db: Database,
    opts: LedgerPriceProviderOpts = {},
  ) {
    this.priority = opts.sourcePriority ?? DEFAULT_SOURCE_PRIORITY;
    this.windowDays = opts.nearestNeighborDays ?? DEFAULT_NEAREST_NEIGHBOR_DAYS;
  }

  async getPrice(args: PriceProviderArgs): Promise<PriceLookup | null> {
    const chain = args.chain ?? "";
    const contract = args.contract_address ?? "";

    // Phase 1: (chain, contract_address) key — preferred when caller provided
    // a non-empty identifier pair.
    if (chain !== "" || contract !== "") {
      const hit = this.lookup({ chain, contract_address: contract, symbol: args.symbol, as_of: args.as_of });
      if (hit) return hit;
    }

    // Phase 2: symbol-only fallback. Use chain='' and contract_address='' rows,
    // which is how native-crypto and pre-migration-030 rows live.
    const hit = this.lookup({ chain: "", contract_address: "", symbol: args.symbol, as_of: args.as_of });
    return hit;
  }

  private lookup(key: { chain: string; contract_address: string; symbol: string; as_of: string }): PriceLookup | null {
    // Exact-date first.
    const exact = this.db
      .query<PriceRow, [string, string, string, string]>(
        `SELECT chain, contract_address, symbol, as_of, source, price_usd
         FROM asset_prices
         WHERE chain = ? AND contract_address = ? AND symbol = ? AND as_of = ?`,
      )
      .all(key.chain, key.contract_address, key.symbol, key.as_of);

    if (exact.length > 0) {
      const best = pickBest(exact, key.as_of, this.priority);
      return { price_usd: best.price_usd, as_of: best.as_of, source: best.source };
    }

    if (this.windowDays <= 0) return null;

    // Nearest neighbor within ±windowDays.
    const start = shiftDate(key.as_of, -this.windowDays);
    const end = shiftDate(key.as_of, +this.windowDays);
    const window = this.db
      .query<PriceRow, [string, string, string, string, string]>(
        `SELECT chain, contract_address, symbol, as_of, source, price_usd
         FROM asset_prices
         WHERE chain = ? AND contract_address = ? AND symbol = ?
           AND as_of BETWEEN ? AND ?`,
      )
      .all(key.chain, key.contract_address, key.symbol, start, end);

    if (window.length === 0) return null;
    const best = pickBest(window, key.as_of, this.priority);
    return { price_usd: best.price_usd, as_of: best.as_of, source: best.source };
  }
}

function shiftDate(yyyymmdd: string, deltaDays: number): string {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(5, 7) - 1;
  const d = +yyyymmdd.slice(8, 10);
  const t = Date.UTC(y, m, d) + deltaDays * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear().toString().padStart(4, "0");
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = dt.getUTCDate().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
