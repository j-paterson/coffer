import { describe, expect, test } from "bun:test";
import { paginate, type PageAdapter } from "../../src/util/paginate";

describe("paginate", () => {
  test("yields zero records when the first page is empty", async () => {
    const adapter: PageAdapter<number, string> = {
      initial: null,
      async fetchPage() {
        return { records: [], next: null };
      },
    };
    const out: number[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(out).toEqual([]);
  });

  test("yields a single page in order", async () => {
    const adapter: PageAdapter<number, string> = {
      initial: null,
      async fetchPage() {
        return { records: [1, 2, 3], next: null };
      },
    };
    const out: number[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(out).toEqual([1, 2, 3]);
  });

  test("walks multiple pages via cursor", async () => {
    const pages: Record<string, { records: number[]; next: string | null }> = {
      "_start_": { records: [1, 2], next: "p2" },
      "p2": { records: [3, 4], next: "p3" },
      "p3": { records: [5], next: null },
    };
    const adapter: PageAdapter<number, string> = {
      initial: "_start_",
      async fetchPage(cursor) {
        return pages[cursor ?? "_start_"]!;
      },
    };
    const out: number[] = [];
    for await (const r of paginate(adapter)) out.push(r);
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  test("early break stops fetching further pages", async () => {
    let calls = 0;
    const adapter: PageAdapter<number, string> = {
      initial: null,
      async fetchPage() {
        calls++;
        return { records: [calls * 10, calls * 10 + 1], next: "more" };
      },
    };
    const out: number[] = [];
    for await (const r of paginate(adapter)) {
      out.push(r);
      if (out.length === 3) break;
    }
    expect(out).toEqual([10, 11, 20]);
    expect(calls).toBe(2);
  });

  test("propagates errors from fetchPage", async () => {
    const adapter: PageAdapter<number, string> = {
      initial: null,
      async fetchPage() {
        throw new Error("boom");
      },
    };
    let caught: unknown;
    try {
      for await (const _ of paginate(adapter)) void _;
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("boom");
  });
});
