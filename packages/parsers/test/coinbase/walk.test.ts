import { describe, expect, test } from "bun:test";
import { runQuantityWalk } from "../../src/coinbase/walk";
import { MapPriceProvider } from "../../src/types/price-provider";
import type { V2Transaction } from "../../src/coinbase/client";

function txn(amount: string, createdAt: string, id = `txn-${createdAt}`): V2Transaction {
  return {
    id,
    amount: { amount, currency: "ETH" },
    created_at: createdAt,
    type: amount.startsWith("-") ? "send" : "buy",
  } as V2Transaction;
}

const COMMON_INPUT = {
  symbol: "ETH",
  chain: "ethereum",
  contract_address: "",
};

describe("runQuantityWalk — ascending walk", () => {
  test("3 deposits across 3 days plus today override → 4 snapshots", async () => {
    const { snapshots: out, warnings } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [
        txn("1.0", "2024-06-13T10:00:00Z"),
        txn("2.0", "2024-06-14T10:00:00Z"),
        txn("3.0", "2024-06-15T10:00:00Z"),
      ],
      todayDate: "2024-06-16",
      todayQty: 6.0,
      priceProvider: new MapPriceProvider({
        "ETH:2024-06-13": 3000,
        "ETH:2024-06-14": 3100,
        "ETH:2024-06-15": 3200,
        "ETH:2024-06-16": 3300,
      }),
    });
    expect(out).toEqual([
      { as_of: "2024-06-13", qty: 1.0, price_usd: 3000 },
      { as_of: "2024-06-14", qty: 3.0, price_usd: 3100 },
      { as_of: "2024-06-15", qty: 6.0, price_usd: 3200 },
      { as_of: "2024-06-16", qty: 6.0, price_usd: 3300 },
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("runQuantityWalk — withdrawal mid-walk", () => {
  test("deposit, withdrawal, deposit reduces qty correctly", async () => {
    const { snapshots: out } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [
        txn("5.0", "2024-06-13T10:00:00Z"),
        txn("-2.0", "2024-06-14T10:00:00Z"),
        txn("1.0", "2024-06-15T10:00:00Z"),
      ],
      todayDate: "2024-06-15",
      todayQty: 4.0,
      priceProvider: new MapPriceProvider({
        "ETH:2024-06-13": 3000,
        "ETH:2024-06-14": 3100,
        "ETH:2024-06-15": 3200,
      }),
    });
    expect(out.map((s) => [s.as_of, s.qty])).toEqual([
      ["2024-06-13", 5.0],
      ["2024-06-14", 3.0],
      ["2024-06-15", 4.0],
    ]);
  });
});

describe("runQuantityWalk — price gap on one date", () => {
  test("skips that snapshot and emits a warning", async () => {
    const { snapshots: out, warnings } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [
        txn("1.0", "2024-06-13T10:00:00Z"),
        txn("1.0", "2024-06-14T10:00:00Z"),
      ],
      todayDate: "2024-06-15",
      todayQty: 2.0,
      priceProvider: new MapPriceProvider({
        "ETH:2024-06-13": 3000,
        "ETH:2024-06-15": 3200,
      }),
    });
    expect(out.map((s) => s.as_of)).toEqual(["2024-06-13", "2024-06-15"]);
    expect(warnings).toEqual([
      { scope: "price_lookup_failed", detail: { symbol: "ETH", as_of: "2024-06-14" } },
    ]);
  });
});

describe("runQuantityWalk — todayQty override differs from walked qty", () => {
  test("today entry takes todayQty (v3 authoritative) not walked qty", async () => {
    const { snapshots: out } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [txn("1.0", "2024-06-15T10:00:00Z")],
      todayDate: "2024-06-15",
      todayQty: 1.123,
      priceProvider: new MapPriceProvider({ "ETH:2024-06-15": 3200 }),
    });
    expect(out).toEqual([{ as_of: "2024-06-15", qty: 1.123, price_usd: 3200 }]);
  });
});

describe("runQuantityWalk — todayQty == null", () => {
  test("v3-absent wallet, v2-only: no today override", async () => {
    const { snapshots: out } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [txn("1.0", "2024-06-14T10:00:00Z")],
      todayDate: "2024-06-15",
      todayQty: null,
      priceProvider: new MapPriceProvider({
        "ETH:2024-06-14": 3100,
        "ETH:2024-06-15": 3200,
      }),
    });
    expect(out.map((s) => [s.as_of, s.qty])).toEqual([
      ["2024-06-14", 1.0],
      ["2024-06-15", 1.0],
    ]);
  });
});

describe("runQuantityWalk — empty txns", () => {
  test("empty txns + todayQty present → today snapshot only", async () => {
    const { snapshots: out } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [],
      todayDate: "2024-06-15",
      todayQty: 1.0,
      priceProvider: new MapPriceProvider({ "ETH:2024-06-15": 3200 }),
    });
    expect(out).toEqual([{ as_of: "2024-06-15", qty: 1.0, price_usd: 3200 }]);
  });

  test("empty txns + todayQty == null → empty list", async () => {
    const { snapshots: out } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [],
      todayDate: "2024-06-15",
      todayQty: null,
      priceProvider: new MapPriceProvider({ "ETH:2024-06-15": 3200 }),
    });
    expect(out).toEqual([]);
  });

  test("empty txns + todayQty == 0 → empty list", async () => {
    const { snapshots: out } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [],
      todayDate: "2024-06-15",
      todayQty: 0,
      priceProvider: new MapPriceProvider({ "ETH:2024-06-15": 3200 }),
    });
    expect(out).toEqual([]);
  });
});

describe("runQuantityWalk — negative balance", () => {
  test("warns, does not emit snapshot for the negative day, resumes on next positive delta", async () => {
    const { snapshots: out, warnings } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [
        txn("-1.0", "2024-06-13T10:00:00Z"),
        txn("2.0", "2024-06-14T10:00:00Z"),
      ],
      todayDate: "2024-06-14",
      todayQty: 1.0,
      priceProvider: new MapPriceProvider({
        "ETH:2024-06-13": 3000,
        "ETH:2024-06-14": 3100,
      }),
    });
    expect(out.map((s) => [s.as_of, s.qty])).toEqual([["2024-06-14", 1.0]]);
    expect(warnings).toEqual([
      { scope: "negative_balance", detail: { as_of: "2024-06-13", qty: -1.0 } },
    ]);
  });
});

describe("runQuantityWalk — todayQty == 0 removes walked entry for today", () => {
  test("v3 says zero overrides any walked non-zero today qty", async () => {
    const { snapshots: out } = await runQuantityWalk({
      ...COMMON_INPUT,
      txns: [txn("1.0", "2024-06-15T10:00:00Z")],
      todayDate: "2024-06-15",
      todayQty: 0,
      priceProvider: new MapPriceProvider({ "ETH:2024-06-15": 3200 }),
    });
    expect(out).toEqual([]);
  });
});
