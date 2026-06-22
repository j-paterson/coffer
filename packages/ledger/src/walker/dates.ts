/** Shared date helpers used across route handlers. */

export interface DateRange {
  from?: string | null;
  to?: string | null;
}

/**
 * Build a SQL date-range WHERE fragment and its bound parameters for a
 * given SQL date expression (e.g. "t.date" or a computed ISO expression).
 *
 * Returns `{ clause, params }` where `clause` is either an empty string
 * or `"AND <expr> >= ? [AND <expr> <= ?]"`, ready to splice into a query.
 */
export function dateSqlClause(
  dateExpr: string,
  range: DateRange | undefined,
): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (range?.from) {
    parts.push(`${dateExpr} >= ?`);
    params.push(range.from);
  }
  if (range?.to) {
    parts.push(`${dateExpr} <= ?`);
    params.push(range.to);
  }
  return {
    clause: parts.length ? `AND ${parts.join(" AND ")}` : "",
    params,
  };
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export type { Granularity } from "../../../../packages/shared/types";
import type { Granularity } from "../../../../packages/shared/types";

export function periodKey(date: string, granularity: Granularity): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  if (granularity === "year") return date.slice(0, 4);
  // ISO week
  const d = new Date(date + "T00:00:00Z");
  const target = new Date(d);
  target.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Inclusive calendar-bucket span for the bucket that `date` falls into.
 *
 * Used so chart drag-selections can report the full bucket's date range
 * to downstream filters: if a user drags the "March 2024" point on a
 * monthly chart, they mean "everything in March", not "only events on
 * the one labeled day". Without this, monthly-chart range deltas drift
 * from daily `date >= / <= ` SQL filters whenever events happen mid-
 * bucket (e.g. Mar 30 DEGEN trades in a March bucket labeled Mar 30).
 */
export function bucketRange(
  date: string,
  granularity: Granularity,
): { start: string; end: string } {
  if (granularity === "day") return { start: date, end: date };
  if (granularity === "year") {
    const y = date.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (granularity === "month") {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    // Day 0 of the next month = last day of this month (UTC).
    const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    return { start: `${date.slice(0, 7)}-01`, end: last };
  }
  // ISO week: Monday → Sunday
  const d = new Date(date + "T00:00:00Z");
  const dayOfWeek = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dayOfWeek);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}
