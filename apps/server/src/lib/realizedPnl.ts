/** Realized P&L — the canonical stream of closed-position gains and losses.
 *
 * Sourced from manual write-downs booked as postings to
 * `expense:realized-loss`. The user books off-exchange losses, perps
 * platform losses, and rugged tokens directly against this expense
 * account and we surface them here as loss events.
 *
 * Every consumer of realized-P&L numbers (the Investments header total,
 * the P&L chart, the trades table) reads through this module so they
 * can't drift out of sync.
 */

import type { Ctx } from "../ctx";
import { bucketRange, dateSqlClause, periodKey, type DateRange } from "@coffer/ledger/walker";
import type { Granularity } from "../../../../packages/shared/types";

export interface RealizedPnlEvent {
  date: string;
  currency: string;
  realized_pnl: number;
  source: "manual";
  type: string;
  description: string;
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

/** Canonical realized-P&L event stream, date-ascending. */
export function realizedPnlEvents(ctx: Ctx, opts?: DateRange): RealizedPnlEvent[] {
  return manualRealizedLosses(ctx, opts);
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
