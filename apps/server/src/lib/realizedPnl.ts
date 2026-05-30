/** Realized P&L — the canonical stream of closed-position gains and losses.
 *
 * Two inputs merge into one sequence:
 *
 *   1. CoinTracker disposal events (SELL, TRADE, MULTI_TOKEN_TRADE, SEND,
 *      BRIDGE) with non-zero Realized Return (USD). Disposals where the
 *      Sent Currency is a stablecoin are filtered out — selling USDC for
 *      USDT at $0.998 isn't investment P&L, it's peg drift noise.
 *
 *   2. Manual write-downs booked as postings to `expense:realized-loss`.
 *      CoinTracker doesn't see perps platforms, off-exchange losses, or
 *      tokens rugged before being on-chain; the user books those directly
 *      against this expense account and we surface them as loss events.
 *
 * Every consumer of realized-P&L numbers (the Investments header total,
 * the P&L chart, the trades table) reads through this module so they
 * can't drift out of sync. Historically the header queried CoinTracker
 * directly and missed the manual losses, producing a $149K gap versus
 * the chart. Fixed by routing all three through realizedPnlEvents().
 */

import type { Ctx } from "../ctx";
import { bucketRange, dateSqlClause, periodKey, type DateRange } from "@coffer/ledger/walker";
import type { Granularity } from "../../../../packages/shared/types";

const DISPOSAL_TYPES = [
  "SELL",
  "TRADE",
  "MULTI_TOKEN_TRADE",
  "SEND",
  "BRIDGE",
] as const;

const STABLECOIN_SENT_EXCLUDE = [
  "USDC",
  "USDT",
  "DAI",
  "BUSD",
  "USD",
] as const;

export interface RealizedPnlEvent {
  date: string;
  currency: string;
  realized_pnl: number;
  source: "cointracker" | "manual";
  type: string;
  description: string;
}

function inlineSqlList(xs: readonly string[]): string {
  return xs.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
}

/** SQL snippet for the CoinTracker Date field (MM/DD/YYYY in the raw
 * payload) normalized to ISO. Exported so endpoints that run their own
 * CoinTracker queries stay consistent. */
export const COINTRACKER_DATE_EXPR = /* sql */ `
  SUBSTR(
    SUBSTR(json_extract(payload, '$.Date'), 7, 4) || '-' ||
    SUBSTR(json_extract(payload, '$.Date'), 1, 2) || '-' ||
    SUBSTR(json_extract(payload, '$.Date'), 4, 2), 1, 10
  )
`;

/** WHERE-fragment + params for the standard realized-P&L disposal filter
 * (types + non-zero + stablecoin exclusion). Endpoints that want the same
 * per-event set as realizedPnlEvents but need richer columns can splice
 * this in to stay aligned with the canonical definition. */
export const REALIZED_DISPOSAL_FILTER_SQL = /* sql */ `
  source = 'cointracker'
  AND json_extract(payload, '$.Type') IN (${inlineSqlList(DISPOSAL_TYPES)})
  AND CAST(json_extract(payload, '$.Realized Return (USD)') AS REAL) != 0
  AND json_extract(payload, '$.Sent Currency') NOT IN (${inlineSqlList(STABLECOIN_SENT_EXCLUDE)})
`;

export function cointrackerRealizedEvents(ctx: Ctx, opts?: DateRange): RealizedPnlEvent[] {
  const { clause, params } = dateSqlClause(COINTRACKER_DATE_EXPR, opts);
  const rows = ctx.db
    .prepare(
      /* sql */ `
        SELECT
          ${COINTRACKER_DATE_EXPR} AS date,
          json_extract(payload, '$.Sent Currency') AS currency,
          json_extract(payload, '$.Type') AS type,
          CAST(json_extract(payload, '$.Realized Return (USD)') AS REAL) AS realized_pnl
        FROM raw_events
        WHERE ${REALIZED_DISPOSAL_FILTER_SQL}
          ${clause}
        ORDER BY date
      `,
    )
    .all(...params) as Array<{
      date: string;
      currency: string;
      type: string;
      realized_pnl: number;
    }>;
  return rows.map((r) => ({
    date: r.date,
    currency: r.currency,
    realized_pnl: r.realized_pnl,
    source: "cointracker",
    type: r.type,
    description: "",
  }));
}

export function manualRealizedLosses(ctx: Ctx, opts?: DateRange): RealizedPnlEvent[] {
  const { clause, params } = dateSqlClause("t.date", opts);
  const rows = ctx.db
    .prepare(
      /* sql */ `
        SELECT t.date, t.description, -p.amount AS realized_pnl
        FROM postings p
        JOIN transactions_v2 t ON t.id = p.txn_id
        WHERE p.account_id = 'expense:realized-loss'
          ${clause}
        ORDER BY t.date
      `,
    )
    .all(...params) as Array<{
      date: string;
      description: string;
      realized_pnl: number;
    }>;
  return rows.map((r) => ({
    date: r.date,
    currency: "USD",
    realized_pnl: r.realized_pnl,
    source: "manual",
    type: "LOSS",
    description: r.description ?? "",
  }));
}

/** Canonical realized-P&L event stream, date-ascending. Merge of the
 * CoinTracker disposal stream and manual write-downs. */
export function realizedPnlEvents(ctx: Ctx, opts?: DateRange): RealizedPnlEvent[] {
  const merged = [
    ...cointrackerRealizedEvents(ctx, opts),
    ...manualRealizedLosses(ctx, opts),
  ];
  merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return merged;
}

export interface RealizedSeriesPoint {
  /** The last event-date seen inside this bucket. Used for the x-axis label. */
  date: string;
  /** Full calendar span the bucket covers (inclusive, ISO). Drag-selection
   *  callbacks use these so downstream `date >= / <=` filters pick up the
   *  same event set the chart is summing, even for buckets larger than a day. */
  bucket_start: string;
  bucket_end: string;
  /** Sum of realized P&L events inside the bucket. */
  realized: number;
  /** Running cumulative through and including the bucket's events. */
  cumulative: number;
}

/**
 * Aggregate a date-ascending realized-P&L event stream into chart buckets.
 *
 * Pure function of `events` — no DB access — so it can be tested in
 * isolation to pin the invariant the chart depends on:
 *
 *   For any index range `[start..end]` in the returned series,
 *     `cumulative[end] − (start > 0 ? cumulative[start-1] : 0)`
 *   equals the sum of `realized_pnl` for every event whose date falls in
 *   `[series[start].bucket_start, series[end].bucket_end]`.
 *
 * This is exactly the relationship the investments UI needs between the
 * chart's drag delta and the TOP TRADES sum — they must decompose the
 * same event set.
 */
export function buildRealizedSeries(
  events: RealizedPnlEvent[],
  granularity: Granularity,
): RealizedSeriesPoint[] {
  const byBucket = new Map<
    string,
    { date: string; realized: number }
  >();
  for (const e of events) {
    const key = periodKey(e.date, granularity);
    const existing = byBucket.get(key);
    if (existing) {
      existing.realized += e.realized_pnl || 0;
      // Keep the latest event date seen for display/x-axis purposes.
      if (e.date > existing.date) existing.date = e.date;
    } else {
      byBucket.set(key, { date: e.date, realized: e.realized_pnl || 0 });
    }
  }

  const buckets = [...byBucket.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  let cumulative = 0;
  const series: RealizedSeriesPoint[] = [];
  for (const b of buckets) {
    cumulative += b.realized;
    const { start, end } = bucketRange(b.date, granularity);
    series.push({
      date: b.date,
      bucket_start: start,
      bucket_end: end,
      realized: b.realized,
      cumulative,
    });
  }
  return series;
}
