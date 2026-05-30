/**
 * Pins the alignment invariant between the realized-P&L chart and the
 * TOP TRADES breakdown on the Investments page.
 *
 * The chart renders buckets (day / week / month / year) and exposes two
 * numbers per point: `cumulative` (running total through the bucket) and
 * a `[bucket_start, bucket_end]` calendar span. The TOP TRADES panel
 * filters trades with `date >= bucket_start AND date <= bucket_end`.
 *
 * Invariant this file locks down:
 *
 *   For any index range `[i..j]` in the series,
 *     series[j].cumulative − (i > 0 ? series[i−1].cumulative : 0)
 *   equals the sum of `realized_pnl` over every event whose `date` is
 *   in `[series[i].bucket_start, series[j].bucket_end]`.
 *
 * Breaking this makes the drag tooltip and the TOP TRADES total disagree
 * in dollars over the same range — the confusion that kicked off these
 * tests. The user's Mar 30 – May 30 2024 bug is reproduced as a
 * scenario test below.
 */

import { describe, expect, test } from "bun:test";
import type { Granularity } from "../../../packages/shared/types";
import { bucketRange } from "@coffer/ledger/walker";
import {
  buildRealizedSeries,
  type RealizedPnlEvent,
} from "../src/lib/realizedPnl";

function ev(date: string, realized_pnl: number): RealizedPnlEvent {
  return {
    date,
    currency: "X",
    realized_pnl,
    source: "cointracker",
    type: "TRADE",
    description: "",
  };
}

function sumInRange(
  events: RealizedPnlEvent[],
  startDate: string,
  endDate: string,
): number {
  return events
    .filter((e) => e.date >= startDate && e.date <= endDate)
    .reduce((s, e) => s + e.realized_pnl, 0);
}

/**
 * For every (i, j) window in the series, assert the cumulative delta
 * matches the raw-event sum over [bucket_start[i], bucket_end[j]]. This
 * is the contract the chart and TOP TRADES both rely on.
 */
function assertAlignment(
  events: RealizedPnlEvent[],
  granularity: Granularity,
): void {
  const series = buildRealizedSeries(events, granularity);
  for (let i = 0; i < series.length; i++) {
    for (let j = i; j < series.length; j++) {
      const before = i > 0 ? series[i - 1]!.cumulative : 0;
      const chartDelta = series[j]!.cumulative - before;
      const tradesSum = sumInRange(
        events,
        series[i]!.bucket_start,
        series[j]!.bucket_end,
      );
      expect(chartDelta).toBeCloseTo(tradesSum, 6);
    }
  }
}

describe("bucketRange", () => {
  test("day granularity: span is the date itself", () => {
    expect(bucketRange("2024-03-30", "day")).toEqual({
      start: "2024-03-30",
      end: "2024-03-30",
    });
  });

  test("month granularity: full calendar month", () => {
    expect(bucketRange("2024-03-30", "month")).toEqual({
      start: "2024-03-01",
      end: "2024-03-31",
    });
    expect(bucketRange("2024-02-15", "month")).toEqual({
      start: "2024-02-01",
      end: "2024-02-29", // leap year
    });
    expect(bucketRange("2023-02-15", "month")).toEqual({
      start: "2023-02-01",
      end: "2023-02-28",
    });
    expect(bucketRange("2024-12-07", "month")).toEqual({
      start: "2024-12-01",
      end: "2024-12-31",
    });
  });

  test("year granularity: full calendar year", () => {
    expect(bucketRange("2024-06-15", "year")).toEqual({
      start: "2024-01-01",
      end: "2024-12-31",
    });
  });

  test("week granularity: Monday through Sunday of that ISO week", () => {
    // 2024-03-30 is a Saturday → week is Mon 2024-03-25 .. Sun 2024-03-31
    expect(bucketRange("2024-03-30", "week")).toEqual({
      start: "2024-03-25",
      end: "2024-03-31",
    });
    // 2024-01-01 is a Monday → week starts that day
    expect(bucketRange("2024-01-01", "week")).toEqual({
      start: "2024-01-01",
      end: "2024-01-07",
    });
  });
});

describe("buildRealizedSeries", () => {
  test("empty input yields empty series", () => {
    expect(buildRealizedSeries([], "month")).toEqual([]);
  });

  test("cumulative runs monotonically across buckets (by sum of realized)", () => {
    const events = [
      ev("2024-01-10", 100),
      ev("2024-02-15", -30),
      ev("2024-02-20", 50),
      ev("2024-03-05", 200),
    ];
    const series = buildRealizedSeries(events, "month");
    expect(series.map((s) => s.realized)).toEqual([100, 20, 200]);
    expect(series.map((s) => s.cumulative)).toEqual([100, 120, 320]);
  });

  test("bucket_start/bucket_end reflect the full calendar bucket, not just the labeled date", () => {
    const events = [ev("2024-03-30", 500)]; // event only on Mar 30
    const [pt] = buildRealizedSeries(events, "month");
    expect(pt!.date).toBe("2024-03-30");
    expect(pt!.bucket_start).toBe("2024-03-01");
    expect(pt!.bucket_end).toBe("2024-03-31");
  });

  test("alignment invariant holds across day/week/month/year", () => {
    // A mix that exercises: mid-bucket events, multi-event days, losses,
    // and buckets with no events in between (January has none in 2024).
    const events = [
      ev("2023-11-02", 10),
      ev("2023-12-28", -5),
      ev("2024-02-15", 25),
      ev("2024-03-05", 40), // mid-March events — these were the problem
      ev("2024-03-18", 60), // for the Mar 30 / May 30 drag
      ev("2024-03-30", 500),
      ev("2024-04-12", -120),
      ev("2024-05-07", 80),
      ev("2024-05-30", 15),
      ev("2024-12-31", 7),
    ];
    for (const g of ["day", "week", "month", "year"] as const) {
      assertAlignment(events, g);
    }
  });

  test(
    "user scenario: monthly chart Mar–May 2024 chart delta equals inclusive trades sum",
    () => {
      // Models the conditions from the screenshot: mid-March events
      // *before* Mar 30, the huge Mar 30 DEGEN-style spike, and normal
      // activity in April and May. Prior to the fix, the chart's range
      // delta skipped the Mar 1–29 events and/or counted the wrong end
      // of May, giving totals that drifted from TOP TRADES.
      const events = [
        ev("2024-02-28", 1000), // prior-bucket context
        ev("2024-03-05", 15_000),
        ev("2024-03-18", 25_000),
        ev("2024-03-30", 466_000), // DEGEN spike day
        ev("2024-04-12", -60_000),
        ev("2024-05-07", 8_000),
        ev("2024-05-30", 2_500),
        ev("2024-06-02", 9_999), // after the range — must NOT leak in
      ];
      const series = buildRealizedSeries(events, "month");
      // Locate the March and May buckets by their bucket_start month tag.
      const marIdx = series.findIndex((s) => s.bucket_start === "2024-03-01");
      const mayIdx = series.findIndex((s) => s.bucket_start === "2024-05-01");
      expect(marIdx).toBeGreaterThan(0);
      expect(mayIdx).toBeGreaterThan(marIdx);

      const before = series[marIdx - 1]!.cumulative;
      const chartDelta = series[mayIdx]!.cumulative - before;

      const tradesSum = sumInRange(
        events,
        series[marIdx]!.bucket_start, // 2024-03-01
        series[mayIdx]!.bucket_end, // 2024-05-31
      );

      expect(chartDelta).toBe(tradesSum);
      // And the expected dollars (chart's delta = trades in Mar+Apr+May):
      expect(chartDelta).toBe(15_000 + 25_000 + 466_000 - 60_000 + 8_000 + 2_500);
      // Crucially, the Feb and June events do NOT leak into the window.
      expect(chartDelta).not.toBe(
        tradesSum + 1_000, // would be true if Feb leaked in
      );
    },
  );

  test(
    "single-bucket range: chart delta equals all events in that bucket",
    () => {
      // Reproduces the narrowest drag: user clicks a single March point.
      // Both bounds should include Mar 1–31 events.
      const events = [
        ev("2024-02-28", 1000),
        ev("2024-03-05", 15_000),
        ev("2024-03-30", 466_000),
        ev("2024-04-01", 9999),
      ];
      const series = buildRealizedSeries(events, "month");
      const marIdx = series.findIndex((s) => s.bucket_start === "2024-03-01");
      const before = series[marIdx - 1]!.cumulative;
      const chartDelta = series[marIdx]!.cumulative - before;
      const tradesSum = sumInRange(events, "2024-03-01", "2024-03-31");
      expect(chartDelta).toBe(tradesSum);
      expect(chartDelta).toBe(481_000);
    },
  );

  test(
    "first-bucket range: chart delta correctly treats prior cumulative as 0",
    () => {
      const events = [
        ev("2024-01-05", 100),
        ev("2024-01-25", 200),
        ev("2024-02-10", 50),
      ];
      const series = buildRealizedSeries(events, "month");
      // Drag that starts at the very first bucket: the "before" cumulative
      // doesn't exist — the drag callback treats it as 0.
      const chartDelta = series[0]!.cumulative - 0;
      const tradesSum = sumInRange(
        events,
        series[0]!.bucket_start,
        series[0]!.bucket_end,
      );
      expect(chartDelta).toBe(tradesSum);
      expect(chartDelta).toBe(300);
    },
  );
});
