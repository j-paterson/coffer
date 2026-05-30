import { Hono } from "hono";
import type { Ctx } from "../ctx";
import { addDays, dateSqlClause, periodKey, type Granularity, buildCurrentCohortCte, COHORT_JOIN, walkSeveralCanonicals } from "@coffer/ledger/walker";
import type {
  HoldingRow,
  InvestmentsHoldingsResponse,
  InvestmentsSeriesResponse,
  InvestmentsRealizedSeriesResponse,
  TradeRow,
  InvestmentFlowRow,
  BasisOverride,
} from "../../../../packages/shared/types";
import {
  computeCryptoBasisFifo,
  matchBasisToHolding,
} from "../lib/cost-basis";
import { canonicalSymbol } from "../lib/symbolAliases";
import {
  COINTRACKER_DATE_EXPR,
  REALIZED_DISPOSAL_FILTER_SQL,
  buildRealizedSeries,
  cointrackerRealizedEvents,
  manualRealizedLosses,
  realizedPnlEvents,
} from "../lib/realizedPnl";

const route = new Hono();

const EXCLUDE_FROM_INVESTMENTS = new Set([
  // Schwab Investor Checking 595 — typed brokerage but used for everyday
  // spending (ATM, Venmo, utilities, credit card payments).
  "simplefin:ACT-e58ed515-b853-45af-bd0d-3e982b2daeac",
]);

const EXCLUDE_FUND_ACCOUNTS = new Set([
  // Schwab Individual 937 — internal Schwab brokerage. Transfers between
  // 595 and 937 are intra-Schwab moves, not external investment flows.
  "simplefin:ACT-f3c5c19e-991a-4bce-8b0c-6c52632ef7f4",
]);

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "BUSD", "USD1"]);

const INVESTMENT_TYPES = ["brokerage", "retirement", "crypto", "alt"] as const;
const FUNDING_TYPES = ["checking", "credit", "savings"] as const;

interface AccountMeta {
  id: string;
  type: string;
  canonical_id: string;
  display_name: string;
  display_name_override: string | null;
}

function loadInvestmentAccounts(ctx: Ctx): AccountMeta[] {
  const typePh = INVESTMENT_TYPES.map(() => "?").join(",");
  const all = ctx.db
    .prepare(
      `SELECT id, type, display_name, display_name_override,
              COALESCE(merged_into, id) AS canonical_id
       FROM accounts
       WHERE type IN (${typePh})
         AND active = 1
         AND id NOT LIKE 'equity:%'`,
    )
    .all(...INVESTMENT_TYPES) as AccountMeta[];
  return all.filter(
    (a) =>
      !EXCLUDE_FROM_INVESTMENTS.has(a.id) &&
      !EXCLUDE_FROM_INVESTMENTS.has(a.canonical_id),
  );
}

interface FlowRow {
  date: string;
  inv_amount: number;
}

function loadCashFlows(ctx: Ctx): FlowRow[] {
  const invTypePh = INVESTMENT_TYPES.map(() => "?").join(",");
  const fundTypePh = FUNDING_TYPES.map(() => "?").join(",");
  const excludeInv = [...EXCLUDE_FROM_INVESTMENTS];
  const excludeInvPh = excludeInv.map(() => "?").join(",");
  const excludeFund = [...EXCLUDE_FUND_ACCOUNTS];
  const excludeFundPh = excludeFund.map(() => "?").join(",");

  return ctx.db
    .prepare(
      `SELECT t.date, p_inv.amount AS inv_amount
       FROM transactions_v2 t
       JOIN postings p_inv ON p_inv.txn_id = t.id
       JOIN accounts a_inv ON a_inv.id = p_inv.account_id
       JOIN postings p_fund ON p_fund.txn_id = t.id AND p_fund.id != p_inv.id
       JOIN accounts a_fund ON a_fund.id = p_fund.account_id
       WHERE t.tags LIKE '%transfer-pair%'
         AND a_inv.type IN (${invTypePh})
         AND a_inv.id NOT IN (${excludeInvPh})
         AND a_fund.type IN (${fundTypePh})
         AND a_fund.id NOT IN (${excludeFundPh})
       ORDER BY t.date`,
    )
    .all(
      ...INVESTMENT_TYPES,
      ...excludeInv,
      ...FUNDING_TYPES,
      ...excludeFund,
    ) as FlowRow[];
}

route.get("/series", (c) => {
  const granularity = (c.req.query("granularity") ?? "month") as Granularity;
  if (!["day", "week", "month", "year"].includes(granularity)) {
    return c.json({ error: "invalid granularity" }, 400);
  }
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");
  const ctx = c.get("ctx") as Ctx;

  const accounts = loadInvestmentAccounts(ctx);
  if (accounts.length === 0) return c.json({ series: [] });
  const canonicalIds = [...new Set(accounts.map((a) => a.canonical_id))];

  const seriesByAcct = walkSeveralCanonicals(ctx, canonicalIds, fromParam, toParam);

  let globalStart = "";
  let globalEnd = "";
  for (const m of seriesByAcct.values()) {
    for (const d of m.keys()) {
      if (!globalStart || d < globalStart) globalStart = d;
      if (!globalEnd || d > globalEnd) globalEnd = d;
    }
  }
  if (!globalStart) return c.json({ series: [] });

  const start = fromParam && fromParam > globalStart ? fromParam : globalStart;
  const end = toParam && toParam < globalEnd ? toParam : globalEnd;

  // Daily portfolio value (assets only, debts excluded).
  const dailyPortfolio = new Map<string, number>();
  let cursor = start;
  while (cursor <= end) {
    let total = 0;
    for (const series of seriesByAcct.values()) {
      const v = series.get(cursor);
      if (v != null && v > 0) total += v;
    }
    dailyPortfolio.set(cursor, total);
    cursor = addDays(cursor, 1);
  }

  // Cumulative cash flows. Fetch ALL flows (no date filter) because the
  // cumulative at `start` depends on the entire prior history.
  const flowRows = loadCashFlows(ctx);
  const flowByDate = new Map<string, number>();
  for (const r of flowRows) {
    flowByDate.set(r.date, (flowByDate.get(r.date) ?? 0) + r.inv_amount);
  }

  let cumulative = 0;
  const cumulativeByDate = new Map<string, number>();
  const sortedFlowDates = [...flowByDate.keys()].sort();
  if (sortedFlowDates.length > 0) {
    let fc = sortedFlowDates[0];
    while (fc <= end) {
      if (flowByDate.has(fc)) cumulative += flowByDate.get(fc)!;
      if (fc >= start) cumulativeByDate.set(fc, cumulative);
      fc = addDays(fc, 1);
    }
  }

  const daily: InvestmentsSeriesResponse["series"] = [];
  cursor = start;
  while (cursor <= end) {
    const pv = dailyPortfolio.get(cursor) ?? 0;
    const ti = cumulativeByDate.get(cursor) ?? 0;
    const tr = pv - ti;
    daily.push({
      date: cursor,
      portfolio_value: pv,
      total_invested: ti,
      total_return: tr,
      return_pct: ti !== 0 ? (tr / ti) * 100 : null,
    });
    cursor = addDays(cursor, 1);
  }

  if (granularity === "day") return c.json({ series: daily });
  const byPeriod = new Map<string, InvestmentsSeriesResponse["series"][number]>();
  for (const p of daily) byPeriod.set(periodKey(p.date, granularity), p);
  return c.json({ series: [...byPeriod.values()] });
});

route.get("/flows", (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const ctx = c.get("ctx") as Ctx;

  const invTypePh = INVESTMENT_TYPES.map(() => "?").join(",");
  const fundTypePh = FUNDING_TYPES.map(() => "?").join(",");
  const excludeInv = [...EXCLUDE_FROM_INVESTMENTS];
  const excludeInvPh = excludeInv.map(() => "?").join(",");
  const excludeFund = [...EXCLUDE_FUND_ACCOUNTS];
  const excludeFundPh = excludeFund.map(() => "?").join(",");

  const { clause: dateClause, params: dateParams } = dateSqlClause("t.date", { from, to });

  const rows = ctx.db
    .prepare(
      `SELECT t.date, t.description,
              p_inv.amount AS inv_amount,
              a_inv.id AS account_id,
              COALESCE(a_inv.display_name_override, a_inv.display_name) AS account_name,
              a_inv.type AS account_type,
              COALESCE(a_fund.display_name_override, a_fund.display_name) AS counterparty_name
       FROM transactions_v2 t
       JOIN postings p_inv ON p_inv.txn_id = t.id
       JOIN accounts a_inv ON a_inv.id = p_inv.account_id
       JOIN postings p_fund ON p_fund.txn_id = t.id AND p_fund.id != p_inv.id
       JOIN accounts a_fund ON a_fund.id = p_fund.account_id
       WHERE t.tags LIKE '%transfer-pair%'
         AND a_inv.type IN (${invTypePh})
         AND a_inv.id NOT IN (${excludeInvPh})
         AND a_fund.type IN (${fundTypePh})
         AND a_fund.id NOT IN (${excludeFundPh})
         ${dateClause}
       ORDER BY t.date DESC`,
    )
    .all(
      ...INVESTMENT_TYPES,
      ...excludeInv,
      ...FUNDING_TYPES,
      ...excludeFund,
      ...dateParams,
    ) as Array<{
      date: string;
      description: string;
      inv_amount: number;
      account_id: string;
      account_name: string;
      account_type: string;
      counterparty_name: string;
    }>;

  const flows = rows.map((r) => ({
    date: r.date,
    amount: r.inv_amount,
    direction: r.inv_amount >= 0 ? ("in" as const) : ("out" as const),
    account_id: r.account_id,
    account_name: r.account_name,
    account_type: r.account_type,
    counterparty_name: r.counterparty_name,
    description: r.description ?? "",
  }));

  return c.json(flows);
});

route.get("/cost-basis", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const stablecoinFilter = "NOT IN ('USDC','USDT','DAI','BUSD','USD')";

  const cryptoBuys = ctx.db
    .prepare(
      `SELECT currency, SUM(txn_count) AS txn_count,
              SUM(total_cost_basis) AS total_cost_basis,
              SUM(total_qty) AS total_qty
       FROM (
         SELECT json_extract(payload, '$.Received Currency') AS currency,
                COUNT(*) AS txn_count,
                SUM(CAST(json_extract(payload, '$.Received Cost Basis (USD)') AS REAL)) AS total_cost_basis,
                SUM(CAST(json_extract(payload, '$.Received Quantity') AS REAL)) AS total_qty
         FROM raw_events
         WHERE source = 'cointracker'
           AND json_extract(payload, '$.Type') IN ('BUY', 'TRADE', 'MULTI_TOKEN_TRADE')
           AND json_extract(payload, '$.Received Currency') ${stablecoinFilter}
         GROUP BY json_extract(payload, '$.Received Currency')
       )
       GROUP BY currency
       ORDER BY total_cost_basis DESC`,
    )
    .all() as Array<{
      currency: string;
      txn_count: number;
      total_cost_basis: number;
      total_qty: number;
    }>;

  // Per-currency breakdown of the canonical realized-P&L stream. The
  // CoinTracker portion groups by Sent Currency; manual write-downs
  // aren't tied to a specific disposed asset and land under a "MANUAL"
  // bucket so the breakdown sums exactly to totals.crypto_realized_return.
  const cointrackerByCurrency = ctx.db
    .prepare(
      `SELECT json_extract(payload, '$.Sent Currency') AS currency,
              COUNT(*) AS txn_count,
              SUM(CAST(json_extract(payload, '$.Sent Cost Basis (USD)') AS REAL)) AS total_cost_basis,
              SUM(CAST(json_extract(payload, '$.Realized Return (USD)') AS REAL)) AS realized_return
       FROM raw_events
       WHERE ${REALIZED_DISPOSAL_FILTER_SQL}
       GROUP BY json_extract(payload, '$.Sent Currency')`,
    )
    .all() as Array<{
      currency: string;
      txn_count: number;
      total_cost_basis: number;
      realized_return: number;
    }>;

  const manualLosses = manualRealizedLosses(ctx);
  const cryptoSells: typeof cointrackerByCurrency = [...cointrackerByCurrency];
  if (manualLosses.length > 0) {
    cryptoSells.push({
      currency: "MANUAL",
      txn_count: manualLosses.length,
      total_cost_basis: 0,
      realized_return: manualLosses.reduce((s, e) => s + e.realized_pnl, 0),
    });
  }
  cryptoSells.sort((a, b) => Math.abs(b.realized_return) - Math.abs(a.realized_return));

  // Cost basis from position_snapshots (SimpleFIN — e.g. Vanguard)
  const snapshotBasis = ctx.db
    .prepare(
      `SELECT p.symbol, p.account_id, a.display_name, a.type,
              ps.cost_basis, ps.value_usd, ps.quantity, ps.as_of
       FROM position_snapshots ps
       JOIN positions p ON p.id = ps.position_id
       JOIN accounts a ON a.id = p.account_id
       WHERE ps.cost_basis IS NOT NULL AND ps.cost_basis != 0
         AND a.type IN ('brokerage', 'retirement', 'crypto', 'alt')
         AND ps.as_of = (
           SELECT MAX(ps2.as_of)
           FROM position_snapshots ps2
           WHERE ps2.position_id = ps.position_id
             AND ps2.cost_basis IS NOT NULL AND ps2.cost_basis != 0
         )
       ORDER BY ps.value_usd DESC`,
    )
    .all() as Array<{
      symbol: string;
      account_id: string;
      display_name: string;
      type: string;
      cost_basis: number;
      value_usd: number;
      quantity: number;
      as_of: string;
    }>;

  const cryptoBuyTotal = cryptoBuys.reduce((s, r) => s + (r.total_cost_basis ?? 0), 0);
  const cryptoSellTotal = cryptoSells.reduce((s, r) => s + (r.realized_return ?? 0), 0);
  const snapshotBasisTotal = snapshotBasis.reduce((s, r) => s + (r.cost_basis ?? 0), 0);

  return c.json({
    crypto_buys: cryptoBuys,
    crypto_sells: cryptoSells,
    snapshot_basis: snapshotBasis,
    totals: {
      crypto_cost_basis: cryptoBuyTotal,
      crypto_realized_return: cryptoSellTotal,
      snapshot_cost_basis: snapshotBasisTotal,
      combined_cost_basis: cryptoBuyTotal + snapshotBasisTotal,
    },
  });
});

route.get("/trades", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const from = c.req.query("from");
  const to = c.req.query("to");

  // Share the disposal filter + date expression with realizedPnl.ts so the
  // trades list and the realized-P&L chart decompose the same event set.
  // Any sum of realized_pnl over a window here equals the chart's delta
  // over that window by construction.
  const { clause: dateClause, params: dateParams } = dateSqlClause(
    COINTRACKER_DATE_EXPR,
    { from, to },
  );

  const rows = ctx.db
    .prepare(
      /* sql */ `
        SELECT
          ${COINTRACKER_DATE_EXPR} AS date,
          json_extract(payload, '$.Type') AS type,
          json_extract(payload, '$.Sent Currency') AS sent_currency,
          CAST(json_extract(payload, '$.Sent Quantity') AS REAL) AS sent_qty,
          CAST(json_extract(payload, '$.Sent Cost Basis (USD)') AS REAL) AS sent_basis,
          json_extract(payload, '$.Received Currency') AS recv_currency,
          CAST(json_extract(payload, '$.Received Quantity') AS REAL) AS recv_qty,
          CAST(json_extract(payload, '$.Received Cost Basis (USD)') AS REAL) AS recv_basis,
          CAST(json_extract(payload, '$.Realized Return (USD)') AS REAL) AS realized_pnl,
          json_extract(payload, '$.Sent Wallet') AS sent_wallet,
          json_extract(payload, '$.Received Wallet') AS recv_wallet
        FROM raw_events
        WHERE ${REALIZED_DISPOSAL_FILTER_SQL}
          ${dateClause}
        ORDER BY date DESC
      `,
    )
    .all(...dateParams) as Array<{
      date: string;
      type: string;
      sent_currency: string;
      sent_qty: number;
      sent_basis: number;
      recv_currency: string;
      recv_qty: number;
      recv_basis: number;
      realized_pnl: number;
      sent_wallet: string;
      recv_wallet: string;
    }>;

  const trades = rows.map((r) => ({
    date: r.date,
    type: r.type,
    sent_currency: r.sent_currency || "",
    sent_qty: r.sent_qty || 0,
    sent_basis: r.sent_basis || 0,
    recv_currency: r.recv_currency || "",
    recv_qty: r.recv_qty || 0,
    recv_basis: r.recv_basis || 0,
    realized_pnl: r.realized_pnl || 0,
    wallet: r.sent_wallet || r.recv_wallet || "",
    canonical_sent: r.sent_currency ? canonicalSymbol(r.sent_currency).toUpperCase() : "",
    canonical_recv: r.recv_currency ? canonicalSymbol(r.recv_currency).toUpperCase() : "",
  }));

  for (const ml of manualRealizedLosses(ctx, { from, to })) {
    trades.push({
      date: ml.date,
      type: ml.type,
      sent_currency: ml.currency,
      sent_qty: Math.abs(ml.realized_pnl),
      sent_basis: Math.abs(ml.realized_pnl),
      recv_currency: "",
      recv_qty: 0,
      recv_basis: 0,
      realized_pnl: ml.realized_pnl,
      wallet: ml.description,
      canonical_sent: "",
      canonical_recv: "",
    });
  }

  trades.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return c.json(trades);
});

route.get("/realized-series", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const granularity = (c.req.query("granularity") ?? "month") as
    | "day"
    | "week"
    | "month"
    | "year";
  if (!["day", "week", "month", "year"].includes(granularity)) {
    return c.json({ error: "invalid granularity" }, 400);
  }

  const series = buildRealizedSeries(realizedPnlEvents(ctx), granularity);
  return c.json({ series });
});

route.get("/holdings", (c) => {
  const ctx = c.get("ctx") as Ctx;
  // Only snapshots in each account's latest sync cohort count as "currently
  // held" — see lib/cohort.ts for why.
  const rows = ctx.db
    .prepare(
      `WITH ${buildCurrentCohortCte(ctx)},
      deduped AS (
        SELECT
          COALESCE(canon.display_name_override, canon.display_name) AS account_name,
          canon.type AS account_type,
          p.symbol, p.chain, p.contract_address,
          ps.quantity, ps.value_usd, ps.cost_basis,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(a.merged_into, p.account_id), p.chain, p.symbol
            ORDER BY
              CASE WHEN p.contract_address = '' THEN 1 ELSE 0 END
          ) AS dedup_rn
        FROM positions p
        JOIN position_snapshots ps ON ps.position_id = p.id
        JOIN accounts a ON a.id = p.account_id
        JOIN accounts canon ON canon.id = COALESCE(a.merged_into, p.account_id)
        ${COHORT_JOIN}
        WHERE canon.active = 1 AND canon.id NOT LIKE 'equity:%'
          AND canon.type IN ('brokerage','retirement','crypto','alt')
      )
      SELECT symbol, chain, contract_address, account_type, account_name,
             quantity, value_usd, cost_basis
      FROM deduped
      WHERE dedup_rn = 1 AND value_usd > 0`,
    )
    .all() as Array<{
      symbol: string;
      chain: string;
      contract_address: string;
      account_type: string;
      account_name: string;
      quantity: number | null;
      value_usd: number;
      cost_basis: number | null;
    }>;

  // FIFO cost basis per canonical crypto symbol from CoinTracker events.
  // Replaces a broken "sum acquired − sum disposed" formula that yielded
  // zero for any symbol traded multiple times.
  const fifoBasis = computeCryptoBasisFifo(ctx.db);

  // User-entered overrides win over FIFO. Account-scoped rows take
  // precedence over symbol-only rows for the same symbol.
  const overrideRows = ctx.db
    .prepare(
      `SELECT symbol, account_id, cost_usd, quantity_at_entry, note
       FROM cost_basis_overrides
       ORDER BY CASE WHEN account_id IS NULL THEN 1 ELSE 0 END`,
    )
    .all() as Array<{
      symbol: string;
      account_id: string | null;
      cost_usd: number;
      quantity_at_entry: number | null;
      note: string | null;
    }>;
  const overridesByScope = new Map<string, (typeof overrideRows)[number]>();
  for (const o of overrideRows) {
    const key = `${o.symbol.toUpperCase()}::${o.account_id ?? ""}`;
    if (!overridesByScope.has(key)) overridesByScope.set(key, o);
  }

  // Group by canonical symbol, aggregate values
  const bySymbol = new Map<string, {
    symbol: string;
    type: "crypto" | "brokerage";
    account_name: string | null;
    value_usd: number;
    quantity: number;
    cost_basis: number | null;
    /** Fraction of live qty covered by a basis source, in [0,1]. null = fully covered. */
    basis_coverage: number | null;
  }>();

  for (const r of rows) {
    const canon = canonicalSymbol(r.symbol, r.chain, r.contract_address).toUpperCase();
    const isBrokerage = r.account_type === "brokerage" || r.account_type === "retirement";
    const key = isBrokerage ? `${canon}::${r.account_name}` : canon;
    const existing = bySymbol.get(key);
    if (existing) {
      existing.value_usd += r.value_usd;
      existing.quantity += r.quantity ?? 0;
      if (isBrokerage && r.cost_basis != null) {
        existing.cost_basis = (existing.cost_basis ?? 0) + r.cost_basis;
      }
    } else {
      bySymbol.set(key, {
        symbol: canon,
        type: isBrokerage ? "brokerage" : "crypto",
        account_name: isBrokerage ? r.account_name : null,
        value_usd: r.value_usd,
        quantity: r.quantity ?? 0,
        cost_basis: isBrokerage ? r.cost_basis : null,
        basis_coverage: null,
      });
    }
  }

  // Stablecoins are cash equivalents — basis ≡ face value, so unrealized
  // P&L is always ~0. Report value as basis so the UI reflects that
  // instead of showing "basis unknown".

  // Apply FIFO cost basis for crypto holdings. `matchBasisToHolding` scales
  // the FIFO queue's per-unit price to the live qty; when CoinTracker has
  // fewer lots than we actually hold (missed DEX swap, external transfer
  // in), it reports basis for the covered portion only and surfaces the
  // coverage ratio so the UI can flag partial basis.
  //
  // Resolution order for crypto basis: user override → stablecoin face
  // value → FIFO. Brokerage basis comes directly from SimpleFIN on the
  // snapshot row and isn't overridden here.
  const holdings = [...bySymbol.values()].map((h) => {
    let basisSource: "simplefin" | "manual" | "stablecoin" | "cointracker-fifo" | null =
      h.cost_basis != null ? "simplefin" : null;

    if (h.type === "crypto" && h.cost_basis == null) {
      const override = overridesByScope.get(`${h.symbol}::`);
      if (override) {
        // Scale the override proportionally when the live qty differs
        // from what it was at entry time. Shrinks basis on partial sells;
        // leaves it unchanged on buys (user should re-enter then).
        const scale =
          override.quantity_at_entry && override.quantity_at_entry > 0
            ? Math.min(1, h.quantity / override.quantity_at_entry)
            : 1;
        h.cost_basis = override.cost_usd * scale;
        basisSource = "manual";
      } else if (STABLECOINS.has(h.symbol)) {
        h.cost_basis = h.value_usd;
        basisSource = "stablecoin";
      } else {
        const fifo = fifoBasis.get(h.symbol);
        if (fifo) {
          const match = matchBasisToHolding(fifo, h.quantity);
          if (match.basis != null && match.basis > 0) {
            h.cost_basis = match.basis;
            h.basis_coverage = match.coverage < 1 ? match.coverage : null;
            basisSource = "cointracker-fifo";
          }
        }
      }
    }
    return {
      ...h,
      basis_source: basisSource,
      unrealized_pnl:
        h.cost_basis != null ? h.value_usd - h.cost_basis : null,
    };
  });

  // Lifetime realized P&L per canonical symbol. The CoinTracker stream's
  // "Sent Currency" is the disposed asset — canonicalizing it folds WETH
  // disposals into the ETH holding's realized column, etc. Manual losses
  // aren't tied to a specific symbol and are surfaced separately via
  // totals.manual_adjustments so the per-row sum still reconciles.
  const realizedByCanon = new Map<string, number>();
  for (const e of cointrackerRealizedEvents(ctx)) {
    const canon = canonicalSymbol(e.currency).toUpperCase();
    realizedByCanon.set(canon, (realizedByCanon.get(canon) ?? 0) + e.realized_pnl);
  }

  const liveHoldings: HoldingRow[] = holdings.map((h) => ({
    ...h,
    realized_pnl: h.type === "crypto" ? realizedByCanon.get(h.symbol) ?? null : null,
    closed: false,
  }));
  // A symbol with no live holding but non-zero lifetime realized is a
  // closed position — surface it so the table gives the full
  // past-and-present picture rather than hiding trades that already paid
  // out.
  const heldSymbols = new Set(liveHoldings.filter((h) => h.type === "crypto").map((h) => h.symbol));
  const closedPositions: HoldingRow[] = [];
  for (const [symbol, realized] of realizedByCanon) {
    if (heldSymbols.has(symbol)) continue;
    if (realized === 0) continue;
    closedPositions.push({
      symbol,
      type: "crypto",
      account_name: null,
      value_usd: 0,
      quantity: 0,
      cost_basis: null,
      basis_coverage: null,
      basis_source: null,
      unrealized_pnl: null,
      realized_pnl: realized,
      closed: true,
    });
  }
  closedPositions.sort(
    (a, b) => Math.abs(b.realized_pnl ?? 0) - Math.abs(a.realized_pnl ?? 0),
  );
  liveHoldings.sort((a, b) => b.value_usd - a.value_usd);
  const allHoldings = [...liveHoldings, ...closedPositions];

  const totalValue = liveHoldings.reduce((s, h) => s + h.value_usd, 0);
  const withBasis = liveHoldings.filter((h) => h.cost_basis != null);
  const totalBasis = withBasis.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
  const totalUnrealized = withBasis.reduce(
    (s, h) => s + (h.unrealized_pnl ?? 0),
    0,
  );
  const manualAdjustments = manualRealizedLosses(ctx).reduce(
    (s, e) => s + e.realized_pnl,
    0,
  );
  const totalRealized =
    allHoldings.reduce((s, h) => s + (h.realized_pnl ?? 0), 0) + manualAdjustments;

  return c.json({
    holdings: allHoldings,
    totals: {
      value: totalValue,
      cost_basis: totalBasis,
      unrealized_pnl: totalUnrealized,
      realized_pnl: totalRealized,
      manual_adjustments: manualAdjustments,
    },
  });
});

route.get("/defi-breakdown", (c) => {
  // Current on-chain holdings grouped by chain → wallet → position. Uses
  // the per-account latest-sync cohort so positions Zerion no longer sees
  // (i.e. disposed) don't linger. No stale-date filter needed; the cohort
  // is definitionally the newest data we have per wallet.
  const ctx = c.get("ctx") as Ctx;
  const rows = ctx.db
    .prepare(
      `WITH ${buildCurrentCohortCte(ctx)},
      deduped AS (
        SELECT
          COALESCE(a.merged_into, p.account_id) AS canonical_account,
          COALESCE(canon.display_name_override, canon.display_name) AS account_name,
          p.symbol, p.chain, p.contract_address,
          ps.quantity, ps.value_usd, ps.as_of,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(a.merged_into, p.account_id), p.chain, p.symbol
            ORDER BY
              CASE WHEN p.contract_address = '' THEN 1 ELSE 0 END
          ) AS dedup_rn
        FROM positions p
        JOIN position_snapshots ps ON ps.position_id = p.id
        JOIN accounts a ON a.id = p.account_id
        JOIN accounts canon ON canon.id = COALESCE(a.merged_into, p.account_id)
        ${COHORT_JOIN}
        WHERE canon.active = 1 AND canon.type = 'crypto'
          AND canon.id NOT LIKE 'equity:%'
      )
      SELECT canonical_account, account_name, symbol, chain, contract_address,
             quantity, value_usd, as_of
      FROM deduped
      WHERE dedup_rn = 1 AND value_usd > 1 AND quantity > 0
      ORDER BY chain, canonical_account, value_usd DESC`,
    )
    .all() as Array<{
      canonical_account: string;
      account_name: string;
      symbol: string;
      chain: string;
      contract_address: string;
      quantity: number;
      value_usd: number;
      as_of: string;
    }>;

  interface Position {
    symbol: string;
    contract_address: string;
    quantity: number;
    value_usd: number;
  }
  interface Wallet {
    account_id: string;
    label: string;
    total: number;
    positions: Position[];
  }
  interface Chain {
    chain: string;
    label: string;
    total: number;
    wallets: Wallet[];
  }

  const chains = new Map<string, Chain>();
  let latestAsOf = "";
  let grandTotal = 0;
  for (const r of rows) {
    if (r.as_of > latestAsOf) latestAsOf = r.as_of;
    grandTotal += r.value_usd;
    const chainKey = r.chain || "other";
    let chain = chains.get(chainKey);
    if (!chain) {
      chain = {
        chain: chainKey,
        label: r.chain
          ? r.chain.charAt(0).toUpperCase() + r.chain.slice(1)
          : "Other",
        total: 0,
        wallets: [],
      };
      chains.set(chainKey, chain);
    }
    chain.total += r.value_usd;
    let wallet = chain.wallets.find((w) => w.account_id === r.canonical_account);
    if (!wallet) {
      wallet = {
        account_id: r.canonical_account,
        label: r.account_name,
        total: 0,
        positions: [],
      };
      chain.wallets.push(wallet);
    }
    wallet.total += r.value_usd;
    wallet.positions.push({
      symbol: r.symbol,
      contract_address: r.contract_address,
      quantity: r.quantity,
      value_usd: r.value_usd,
    });
  }

  const chainList = [...chains.values()].sort((a, b) => b.total - a.total);
  for (const ch of chainList) ch.wallets.sort((a, b) => b.total - a.total);

  return c.json({
    as_of: latestAsOf,
    total: grandTotal,
    chains: chainList,
  });
});

// Manual basis entries for holdings that CoinTracker FIFO can't resolve
// (symbols CoinTracker never saw, or positions where disposed ≥ acquired
// so FIFO runs dry). Scoped per-symbol, optionally per-account.

route.get("/basis-overrides", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const rows = ctx.db
    .prepare(
      `SELECT id, symbol, account_id, cost_usd, quantity_at_entry, note,
              created_at, updated_at
       FROM cost_basis_overrides
       ORDER BY symbol ASC`,
    )
    .all();
  return c.json(rows);
});

route.put("/basis-overrides", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    symbol?: unknown;
    account_id?: unknown;
    cost_usd?: unknown;
    quantity_at_entry?: unknown;
    note?: unknown;
  } | null;
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!symbol) return c.json({ error: "symbol required" }, 400);
  const cost = Number(body.cost_usd);
  if (!Number.isFinite(cost) || cost < 0) {
    return c.json({ error: "cost_usd must be a non-negative number" }, 400);
  }
  const accountId =
    typeof body.account_id === "string" && body.account_id.trim() !== ""
      ? body.account_id.trim()
      : null;
  const qty =
    body.quantity_at_entry != null && Number.isFinite(Number(body.quantity_at_entry))
      ? Number(body.quantity_at_entry)
      : null;
  const note = typeof body.note === "string" ? body.note : null;
  const ctx = c.get("ctx") as Ctx;

  ctx.db
    .prepare(
      `INSERT INTO cost_basis_overrides
         (symbol, account_id, cost_usd, quantity_at_entry, note, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(symbol, COALESCE(account_id, ''))
       DO UPDATE SET cost_usd = excluded.cost_usd,
                     quantity_at_entry = excluded.quantity_at_entry,
                     note = excluded.note,
                     updated_at = CURRENT_TIMESTAMP`,
    )
    .run(symbol, accountId, cost, qty, note);

  const row = ctx.db
    .prepare(
      `SELECT id, symbol, account_id, cost_usd, quantity_at_entry, note,
              created_at, updated_at
       FROM cost_basis_overrides
       WHERE symbol = ? AND COALESCE(account_id, '') = COALESCE(?, '')`,
    )
    .get(symbol, accountId);
  return c.json(row);
});

route.delete("/basis-overrides/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "invalid id" }, 400);
  }
  const ctx = c.get("ctx") as Ctx;
  const res = ctx.db
    .prepare(`DELETE FROM cost_basis_overrides WHERE id = ?`)
    .run(id);
  return c.json({ deleted: res.changes });
});

export default route;
