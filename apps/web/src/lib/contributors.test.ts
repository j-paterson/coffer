import { describe, expect, it } from "vitest";
import { rangeContributors } from "./contributors";

const snap = (as_of: string, h: Record<string, number>) => ({
  as_of,
  total: Object.values(h).reduce((a, b) => a + b, 0),
  holdings: Object.entries(h).map(([symbol, value_usd]) => ({ symbol, value_usd })),
});

const snaps = [
  snap("2026-01-01", { Checking: 1000, Brokerage: 5000, Card: -200, Art: 300 }),
  snap("2026-02-01", { Checking: 1500, Brokerage: 4000, Card: -900, Art: 300, Wallet: 50 }),
];

describe("rangeContributors", () => {
  it("ranks accounts by absolute change", () => {
    const r = rangeContributors(snaps, "2026-01-01", "2026-02-01")!;
    expect(r.top).toEqual([
      { label: "Brokerage", delta: -1000 },
      { label: "Card", delta: -700 },
      { label: "Checking", delta: 500 },
      { label: "Wallet", delta: 50 },
    ]);
    expect(r.total).toBe(-1150);
  });

  it("counts an account that disappeared as losing its whole balance", () => {
    const r = rangeContributors(
      [snap("2026-01-01", { A: 100, B: 40 }), snap("2026-01-02", { B: 40 })],
      "2026-01-01",
      "2026-01-02",
    )!;
    expect(r.top).toEqual([{ label: "A", delta: -100 }]);
  });

  it("rolls everything past the top n into other", () => {
    const r = rangeContributors(snaps, "2026-01-01", "2026-02-01", 2)!;
    expect(r.top.map((c) => c.label)).toEqual(["Brokerage", "Card"]);
    expect(r.other).toBe(550);
    expect(r.top.reduce((a, c) => a + c.delta, 0) + r.other).toBe(r.total);
  });

  it("uses the latest snapshot on or before each date", () => {
    const r = rangeContributors(snaps, "2025-12-15", "2026-01-20")!;
    // No start snapshot yet: everything at the end counts as new.
    expect(r.total).toBe(6100);
  });

  it("returns null when the range ends before any history", () => {
    expect(rangeContributors(snaps, "2025-01-01", "2025-06-01")).toBeNull();
  });
});
