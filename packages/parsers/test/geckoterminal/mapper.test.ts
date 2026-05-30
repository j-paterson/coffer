import { describe, expect, test } from "bun:test";
import {
  pickHighestLiquidityPool,
  ohlcvToPriceOps,
} from "../../src/geckoterminal/mapper";
import type { GeckoTerminalPoolListResponse, OhlcvPoint } from "../../src/geckoterminal/client";
import type { GeckoTerminalTarget } from "../../src/geckoterminal/config";

describe("pickHighestLiquidityPool", () => {
  test("picks the entry with the highest finite reserve_in_usd", () => {
    const response: GeckoTerminalPoolListResponse = {
      data: [
        { id: "base_0xpool_a", type: "pool", attributes: { reserve_in_usd: "1234567.89" } },
        { id: "base_0xpool_b", type: "pool", attributes: { reserve_in_usd: "15500000" } },
        { id: "base_0xpool_c", type: "pool", attributes: { reserve_in_usd: "42000" } },
      ],
    };
    const pick = pickHighestLiquidityPool(response, "base");
    expect(pick).toEqual({ pool_address: "0xpool_b", reserve_in_usd: 15_500_000 });
  });

  test("strips the {network}_ prefix from the id", () => {
    const response: GeckoTerminalPoolListResponse = {
      data: [
        { id: "eth_0xABC", type: "pool", attributes: { reserve_in_usd: "1" } },
      ],
    };
    const pick = pickHighestLiquidityPool(response, "eth");
    expect(pick).toEqual({ pool_address: "0xABC", reserve_in_usd: 1 });
  });

  test("returns null when data is empty", () => {
    expect(pickHighestLiquidityPool({ data: [] }, "eth")).toBeNull();
  });

  test("skips entries with non-finite reserve_in_usd", () => {
    const response: GeckoTerminalPoolListResponse = {
      data: [
        { id: "eth_0xa", type: "pool", attributes: { reserve_in_usd: null } },
        { id: "eth_0xb", type: "pool", attributes: { reserve_in_usd: "not a number" } },
        { id: "eth_0xc", type: "pool", attributes: { reserve_in_usd: "100" } },
      ],
    };
    expect(pickHighestLiquidityPool(response, "eth")).toEqual({
      pool_address: "0xc", reserve_in_usd: 100,
    });
  });

  test("returns null when all reserves are non-finite", () => {
    const response: GeckoTerminalPoolListResponse = {
      data: [
        { id: "eth_0xa", type: "pool", attributes: { reserve_in_usd: null } },
        { id: "eth_0xb", type: "pool", attributes: { reserve_in_usd: "xyz" } },
      ],
    };
    expect(pickHighestLiquidityPool(response, "eth")).toBeNull();
  });

  test("ties broken by first-seen order", () => {
    const response: GeckoTerminalPoolListResponse = {
      data: [
        { id: "eth_0xfirst",  type: "pool", attributes: { reserve_in_usd: "100" } },
        { id: "eth_0xsecond", type: "pool", attributes: { reserve_in_usd: "100" } },
      ],
    };
    expect(pickHighestLiquidityPool(response, "eth")).toEqual({
      pool_address: "0xfirst", reserve_in_usd: 100,
    });
  });
});

describe("ohlcvToPriceOps", () => {
  const TARGET: GeckoTerminalTarget = {
    symbol: "USDC",
    chain: "ethereum",
    contract: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
  };

  function pt(ts: number, close: number): OhlcvPoint {
    return [ts, 0, 0, 0, close, 0];
  }

  test("emits one asset_price op per valid point", () => {
    const points = [pt(1715731200, 0.55), pt(1715817600, 0.56)];
    const ops = Array.from(ohlcvToPriceOps(points, TARGET, 0));
    expect(ops).toHaveLength(2);
    expect(ops[0]!.kind).toBe("asset_price");
    expect((ops[0] as { draft: { symbol: string; chain: string; contract_address: string | null; as_of: string; source: string; price_usd: number } }).draft).toEqual({
      symbol: "USDC",
      chain: "ethereum",
      contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      as_of: "2024-05-15",
      source: "geckoterminal",
      price_usd: 0.55,
    });
  });

  test("skips points where ts < from_ts", () => {
    // from_ts = 2024-05-15 UTC midnight (1715731200)
    const points = [pt(1715644800, 0.50), pt(1715731200, 0.55)];
    const ops = Array.from(ohlcvToPriceOps(points, TARGET, 1715731200));
    expect(ops).toHaveLength(1);
    expect((ops[0] as { draft: { as_of: string } }).draft.as_of).toBe("2024-05-15");
  });

  test("skips points with close <= 0", () => {
    const points = [pt(1715731200, 0), pt(1715817600, -0.5), pt(1715904000, 1)];
    const ops = Array.from(ohlcvToPriceOps(points, TARGET, 0));
    expect(ops).toHaveLength(1);
    expect((ops[0] as { draft: { as_of: string } }).draft.as_of).toBe("2024-05-17");
  });

  test("skips points with non-numeric or non-finite ts/close", () => {
    const bad: OhlcvPoint[] = [
      [Number.NaN, 0, 0, 0, 0.5, 0],
      [1715731200, 0, 0, 0, Number.NaN, 0],
      [1715817600, 0, 0, 0, Number.POSITIVE_INFINITY, 0],
    ];
    const ops = Array.from(ohlcvToPriceOps(bad, TARGET, 0));
    expect(ops).toHaveLength(0);
  });

  test("dedups by as_of within a single call", () => {
    // Two points on the same UTC day.
    const points = [pt(1715731200, 0.55), pt(1715731260, 0.60)];
    const ops = Array.from(ohlcvToPriceOps(points, TARGET, 0));
    expect(ops).toHaveLength(1);
    expect((ops[0] as { draft: { price_usd: number } }).draft.price_usd).toBe(0.55);
  });

  test("lowercases contract_address regardless of caller casing", () => {
    const ops = Array.from(ohlcvToPriceOps([pt(1715731200, 1)], TARGET, 0));
    expect((ops[0] as { draft: { contract_address: string | null } }).draft.contract_address).toBe(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
  });
});
