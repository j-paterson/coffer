import type { PageAdapter } from "../../util/paginate";

export interface TimeWindowAdapterOpts<R> {
  start: Date;        // inclusive
  end: Date;          // exclusive
  windowMs: number;
  fetchRange(from: Date, to: Date): Promise<R[]>;
}

export interface TimeWindowCursor {
  from: Date;
  to: Date;
}

export function timeWindowAdapter<R>(
  opts: TimeWindowAdapterOpts<R>,
): PageAdapter<R, TimeWindowCursor> {
  const { start, end, windowMs, fetchRange } = opts;

  function windowFrom(t: Date): TimeWindowCursor | null {
    if (t.getTime() >= end.getTime()) return null;
    const next = new Date(Math.min(t.getTime() + windowMs, end.getTime()));
    return { from: t, to: next };
  }

  return {
    initial: windowFrom(start),
    async fetchPage(cursor) {
      if (cursor === null) return { records: [], next: null };
      const records = await fetchRange(cursor.from, cursor.to);
      return { records, next: windowFrom(cursor.to) };
    },
  };
}
