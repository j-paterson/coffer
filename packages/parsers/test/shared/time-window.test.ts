import { describe, expect, test } from "bun:test";
import { paginate } from "../../src/util/paginate";
import { timeWindowAdapter } from "../../src/shared/pagination/time-window";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("timeWindowAdapter", () => {
  test("single window: range smaller than windowMs fetches once", async () => {
    const calls: Array<{ from: Date; to: Date }> = [];
    const adapter = timeWindowAdapter<number>({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-05T00:00:00Z"),
      windowMs: 30 * DAY_MS,
      async fetchRange(from, to) {
        calls.push({ from, to });
        return [1, 2, 3];
      },
    });
    const out: number[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(out).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(calls[0]!.to.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  test("multi-window: even split walks forward in fixed chunks", async () => {
    const calls: Array<[string, string]> = [];
    const adapter = timeWindowAdapter<string>({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-31T00:00:00Z"),
      windowMs: 10 * DAY_MS,
      async fetchRange(from, to) {
        calls.push([from.toISOString(), to.toISOString()]);
        return [`${from.toISOString()}..${to.toISOString()}`];
      },
    });
    const out: string[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(calls).toEqual([
      ["2026-01-01T00:00:00.000Z", "2026-01-11T00:00:00.000Z"],
      ["2026-01-11T00:00:00.000Z", "2026-01-21T00:00:00.000Z"],
      ["2026-01-21T00:00:00.000Z", "2026-01-31T00:00:00.000Z"],
    ]);
    expect(out).toHaveLength(3);
  });

  test("multi-window: last window is truncated to end", async () => {
    const calls: Array<[string, string]> = [];
    const adapter = timeWindowAdapter<number>({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-25T00:00:00Z"),
      windowMs: 10 * DAY_MS,
      async fetchRange(from, to) {
        calls.push([from.toISOString(), to.toISOString()]);
        return [];
      },
    });
    for await (const _ of paginate(adapter)) void _;
    expect(calls).toEqual([
      ["2026-01-01T00:00:00.000Z", "2026-01-11T00:00:00.000Z"],
      ["2026-01-11T00:00:00.000Z", "2026-01-21T00:00:00.000Z"],
      ["2026-01-21T00:00:00.000Z", "2026-01-25T00:00:00.000Z"],
    ]);
  });

  test("empty range (start === end) fetches zero pages", async () => {
    let calls = 0;
    const adapter = timeWindowAdapter<number>({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-01T00:00:00Z"),
      windowMs: DAY_MS,
      async fetchRange() {
        calls++;
        return [];
      },
    });
    const out: number[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(calls).toBe(0);
    expect(out).toEqual([]);
  });

  test("inverted range (start > end) fetches zero pages", async () => {
    let calls = 0;
    const adapter = timeWindowAdapter<number>({
      start: new Date("2026-02-01T00:00:00Z"),
      end: new Date("2026-01-01T00:00:00Z"),
      windowMs: DAY_MS,
      async fetchRange() {
        calls++;
        return [];
      },
    });
    const out: number[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(calls).toBe(0);
    expect(out).toEqual([]);
  });

  test("records from each window are flattened in order", async () => {
    const adapter = timeWindowAdapter<number>({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-21T00:00:00Z"),
      windowMs: 10 * DAY_MS,
      async fetchRange(from) {
        if (from.getUTCDate() === 1) return [1, 2];
        if (from.getUTCDate() === 11) return [3, 4];
        return [];
      },
    });
    const out: number[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(out).toEqual([1, 2, 3, 4]);
  });
});
