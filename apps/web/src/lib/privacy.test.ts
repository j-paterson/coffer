import { describe, it, expect, vi, afterEach } from "vitest";
import { privacyPoints, privacySnapshots, privacySlices, privacyLabeledSlices } from "./privacy";
import type { Point } from "./LineChart";
import type { StackedSnapshot } from "./StackedSnapshotChart";
import type { Slice } from "./Donut";
import type { LabeledSlice } from "../components/LabeledDonut";

const SAMPLE_POINTS: Point[] = Array.from({ length: 30 }, (_, i) => ({
  x: `2025-01-${String(i + 1).padStart(2, "0")}`,
  y: 100_000 + i * 1_000,
  xStart: `2025-01-${String(i + 1).padStart(2, "0")}`,
  xEnd: `2025-01-${String(i + 1).padStart(2, "0")}`,
}));

describe("privacyPoints", () => {
  afterEach(() => vi.useRealTimers());

  it("returns same length as input", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyPoints(SAMPLE_POINTS, "net_worth");
    expect(result).toHaveLength(SAMPLE_POINTS.length);
  });

  it("preserves x-axis dates and optional fields", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyPoints(SAMPLE_POINTS, "net_worth");
    result.forEach((p, i) => {
      expect(p.x).toBe(SAMPLE_POINTS[i].x);
      expect(p.xStart).toBe(SAMPLE_POINTS[i].xStart);
      expect(p.xEnd).toBe(SAMPLE_POINTS[i].xEnd);
    });
  });

  it("replaces y values (not the originals)", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyPoints(SAMPLE_POINTS, "net_worth");
    const allMatch = result.every((p, i) => p.y === SAMPLE_POINTS[i].y);
    expect(allMatch).toBe(false);
  });

  it("all y values are positive", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyPoints(SAMPLE_POINTS, "net_worth");
    result.forEach((p) => expect(p.y).toBeGreaterThan(0));
  });

  it("trends upward (first < last for 30-point series)", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyPoints(SAMPLE_POINTS, "net_worth");
    expect(result[result.length - 1].y).toBeGreaterThan(result[0].y);
  });

  it("is deterministic (same day + same key = same output)", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const a = privacyPoints(SAMPLE_POINTS, "net_worth");
    const b = privacyPoints(SAMPLE_POINTS, "net_worth");
    expect(a).toEqual(b);
  });

  it("different seriesKey produces different output", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const a = privacyPoints(SAMPLE_POINTS, "net_worth");
    const b = privacyPoints(SAMPLE_POINTS, "assets");
    const allMatch = a.every((p, i) => p.y === b[i].y);
    expect(allMatch).toBe(false);
  });

  it("returns empty array for empty input", () => {
    expect(privacyPoints([], "net_worth")).toEqual([]);
  });
});

const SAMPLE_SNAPSHOTS: StackedSnapshot[] = Array.from({ length: 20 }, (_, i) => ({
  as_of: `2025-01-${String(i + 1).padStart(2, "0")}`,
  total: 50_000 + i * 500,
  holdings: [
    { symbol: "ETH", value_usd: 30_000 + i * 300 },
    { symbol: "BTC", value_usd: 20_000 + i * 200 },
  ],
}));

describe("privacySnapshots", () => {
  afterEach(() => vi.useRealTimers());

  it("returns same length as input", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySnapshots(SAMPLE_SNAPSHOTS, "portfolio");
    expect(result).toHaveLength(SAMPLE_SNAPSHOTS.length);
  });

  it("preserves as_of dates", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySnapshots(SAMPLE_SNAPSHOTS, "portfolio");
    result.forEach((s, i) => expect(s.as_of).toBe(SAMPLE_SNAPSHOTS[i].as_of));
  });

  it("preserves number of holdings and symbols", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySnapshots(SAMPLE_SNAPSHOTS, "portfolio");
    result.forEach((s, i) => {
      expect(s.holdings).toHaveLength(SAMPLE_SNAPSHOTS[i].holdings.length);
      s.holdings.forEach((h, j) => {
        expect(h.symbol).toBe(SAMPLE_SNAPSHOTS[i].holdings[j].symbol);
      });
    });
  });

  it("holding values sum to total", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySnapshots(SAMPLE_SNAPSHOTS, "portfolio");
    result.forEach((s) => {
      const holdingsSum = s.holdings.reduce((acc, h) => acc + h.value_usd, 0);
      expect(holdingsSum).toBeCloseTo(s.total, 2);
    });
  });

  it("all values are positive", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySnapshots(SAMPLE_SNAPSHOTS, "portfolio");
    result.forEach((s) => {
      expect(s.total).toBeGreaterThan(0);
      s.holdings.forEach((h) => expect(h.value_usd).toBeGreaterThan(0));
    });
  });

  it("is deterministic", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const a = privacySnapshots(SAMPLE_SNAPSHOTS, "portfolio");
    const b = privacySnapshots(SAMPLE_SNAPSHOTS, "portfolio");
    expect(a).toEqual(b);
  });

  it("returns empty array for empty input", () => {
    expect(privacySnapshots([], "portfolio")).toEqual([]);
  });
});

const SAMPLE_SLICES: Slice[] = [
  { label: "Groceries", value: 800, colorClass: "text-emerald-500" },
  { label: "Rent", value: 2000, colorClass: "text-violet-500" },
  { label: "Dining", value: 400, colorClass: "text-amber-500" },
];

describe("privacySlices", () => {
  afterEach(() => vi.useRealTimers());

  it("returns same length as input", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySlices(SAMPLE_SLICES, "spending");
    expect(result).toHaveLength(SAMPLE_SLICES.length);
  });

  it("preserves labels and colorClass", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySlices(SAMPLE_SLICES, "spending");
    result.forEach((s, i) => {
      expect(s.label).toBe(SAMPLE_SLICES[i].label);
      expect(s.colorClass).toBe(SAMPLE_SLICES[i].colorClass);
    });
  });

  it("replaces values (not originals)", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySlices(SAMPLE_SLICES, "spending");
    const allMatch = result.every((s, i) => s.value === SAMPLE_SLICES[i].value);
    expect(allMatch).toBe(false);
  });

  it("all values are positive", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacySlices(SAMPLE_SLICES, "spending");
    result.forEach((s) => expect(s.value).toBeGreaterThan(0));
  });

  it("is deterministic", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const a = privacySlices(SAMPLE_SLICES, "spending");
    const b = privacySlices(SAMPLE_SLICES, "spending");
    expect(a).toEqual(b);
  });

  it("returns empty array for empty input", () => {
    expect(privacySlices([], "spending")).toEqual([]);
  });
});

const SAMPLE_LABELED_SLICES: LabeledSlice[] = [
  { label: "Mortgage", value: 1500, color: "#10b981" },
  { label: "Car", value: 400, color: "#8b5cf6" },
  { label: "Student", value: 300, color: "#f59e0b" },
];

describe("privacyLabeledSlices", () => {
  afterEach(() => vi.useRealTimers());

  it("returns same length as input", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyLabeledSlices(SAMPLE_LABELED_SLICES, "debt");
    expect(result).toHaveLength(SAMPLE_LABELED_SLICES.length);
  });

  it("preserves labels and hex colors", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyLabeledSlices(SAMPLE_LABELED_SLICES, "debt");
    result.forEach((s, i) => {
      expect(s.label).toBe(SAMPLE_LABELED_SLICES[i].label);
      expect(s.color).toBe(SAMPLE_LABELED_SLICES[i].color);
    });
  });

  it("replaces values", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const result = privacyLabeledSlices(SAMPLE_LABELED_SLICES, "debt");
    const allMatch = result.every((s, i) => s.value === SAMPLE_LABELED_SLICES[i].value);
    expect(allMatch).toBe(false);
  });

  it("is deterministic", () => {
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00Z") });
    const a = privacyLabeledSlices(SAMPLE_LABELED_SLICES, "debt");
    const b = privacyLabeledSlices(SAMPLE_LABELED_SLICES, "debt");
    expect(a).toEqual(b);
  });

  it("returns empty array for empty input", () => {
    expect(privacyLabeledSlices([], "debt")).toEqual([]);
  });
});
