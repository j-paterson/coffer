import { describe, expect, test } from "bun:test";
import { mapPositions } from "../../src/zerion/mapper";
import type { ZerionPositionsResponse } from "../../src/zerion/client";

const ADDR_LOWER = "0xabcdef0123456789abcdef0123456789abcdef01";
const ADDR_MIXED = "0xABCDEF0123456789abcdef0123456789ABCDEF01";

function pos(args: {
  symbol: string;
  chain: string;
  fungibleId: string;
  qty: number;
  value: number;
  implementations?: Array<{ chain_id: string; address: string | null }>;
}): ZerionPositionsResponse["data"][number] {
  return {
    id: `p-${args.symbol}-${args.chain}`,
    type: "positions",
    attributes: {
      quantity: { float: args.qty },
      value: args.value,
      fungible_info: {
        symbol: args.symbol,
        implementations: args.implementations ?? [
          { chain_id: args.chain, address: `0x${args.symbol.toLowerCase()}contract` },
        ],
      },
    },
    relationships: {
      chain:    { data: { id: args.chain } },
      fungible: { data: { id: args.fungibleId } },
    },
  };
}

describe("mapPositions", () => {
  test("emits account_discovery once per (wallet,chain), then position_snapshot per row", () => {
    const response: ZerionPositionsResponse = {
      data: [
        pos({ symbol: "USDC", chain: "ethereum", fungibleId: "f-usdc", qty: 1000, value: 1000 }),
        pos({ symbol: "ETH",  chain: "ethereum", fungibleId: "f-eth",  qty: 1.5,  value: 3000,
              implementations: [{ chain_id: "ethereum", address: null }] }),  // native
        pos({ symbol: "USDC", chain: "base",     fungibleId: "f-usdc", qty: 500,  value: 500 }),
      ],
    };

    const result = mapPositions(response, {
      address: ADDR_LOWER,
      asOf: "2023-11-25",
      minValueUsd: 1.0,
    });
    const ops = [...result.ops];

    // 2 account_discovery (ethereum, base) + 3 position_snapshot = 5 ops
    expect(ops).toHaveLength(5);

    // Group A: ethereum
    expect(ops[0]!.kind).toBe("account_discovery");
    expect((ops[0] as { draft: { id: string } }).draft.id).toBe(`zerion:ethereum:${ADDR_LOWER}`);
    expect((ops[0] as { draft: { institution: string; type: string; mode: string } }).draft.institution).toBe("zerion");
    expect((ops[0] as { draft: { institution: string; type: string; mode: string } }).draft.type).toBe("crypto");
    expect((ops[0] as { draft: { institution: string; type: string; mode: string } }).draft.mode).toBe("live");

    expect(ops[1]!.kind).toBe("position_snapshot");
    expect((ops[1] as { draft: { symbol: string; chain: string; contract_address: string | null; qty: number; price_usd: number | null } }).draft).toEqual({
      account_id: `zerion:ethereum:${ADDR_LOWER}`,
      symbol: "USDC",
      chain: "ethereum",
      contract_address: "0xusdccontract",
      as_of: "2023-11-25",
      qty: 1000,
      price_usd: 1.0,
      source: "zerion",
    } as never);

    // native ETH → contract_address null
    expect(ops[2]!.kind).toBe("position_snapshot");
    expect((ops[2] as { draft: { symbol: string; contract_address: string | null; price_usd: number } }).draft.symbol).toBe("ETH");
    expect((ops[2] as { draft: { symbol: string; contract_address: string | null; price_usd: number } }).draft.contract_address).toBeNull();
    expect((ops[2] as { draft: { symbol: string; contract_address: string | null; price_usd: number } }).draft.price_usd).toBe(2000);  // 3000 / 1.5

    // Group B: base
    expect(ops[3]!.kind).toBe("account_discovery");
    expect((ops[3] as { draft: { id: string } }).draft.id).toBe(`zerion:base:${ADDR_LOWER}`);
    expect(ops[4]!.kind).toBe("position_snapshot");
    expect((ops[4] as { draft: { chain: string } }).draft.chain).toBe("base");

    // Accumulator sets
    expect([...result.chains].sort()).toEqual(["base", "ethereum"]);
    expect([...result.fungibles].sort()).toEqual(["f-eth", "f-usdc"]);
  });

  test("lowercases the wallet address inside account_id even if config kept mixed case", () => {
    const response: ZerionPositionsResponse = {
      data: [
        pos({ symbol: "ETH", chain: "ethereum", fungibleId: "f-eth", qty: 1, value: 2000 }),
      ],
    };
    const result = mapPositions(response, {
      address: ADDR_MIXED,
      asOf: "2023-11-25",
      minValueUsd: 1.0,
    });
    const ops = [...result.ops];
    expect((ops[0] as { draft: { id: string } }).draft.id).toBe(`zerion:ethereum:${ADDR_LOWER}`);
    expect((ops[1] as { draft: { account_id: string } }).draft.account_id).toBe(`zerion:ethereum:${ADDR_LOWER}`);
  });

  test("filters rows below min_value_usd; a chain with only dust emits zero ops", () => {
    const response: ZerionPositionsResponse = {
      data: [
        pos({ symbol: "DUST", chain: "ethereum", fungibleId: "f-dust", qty: 100, value: 0.50 }),
        pos({ symbol: "USDC", chain: "ethereum", fungibleId: "f-usdc", qty: 100, value: 100 }),
        // entire 'optimism' chain is dust → should NOT produce account_discovery
        pos({ symbol: "DUST", chain: "optimism", fungibleId: "f-dust", qty: 10, value: 0.20 }),
      ],
    };
    const result = mapPositions(response, {
      address: ADDR_LOWER,
      asOf: "2023-11-25",
      minValueUsd: 1.0,
    });
    const ops = [...result.ops];
    // 1 account_discovery (ethereum) + 1 position_snapshot (USDC) = 2
    expect(ops).toHaveLength(2);
    expect(ops[0]!.kind).toBe("account_discovery");
    expect((ops[0] as { draft: { id: string } }).draft.id).toBe(`zerion:ethereum:${ADDR_LOWER}`);
    expect(ops[1]!.kind).toBe("position_snapshot");
    expect((ops[1] as { draft: { symbol: string } }).draft.symbol).toBe("USDC");
    expect([...result.chains]).toEqual(["ethereum"]);
    expect([...result.fungibles]).toEqual(["f-usdc"]);
  });

  test("drops malformed rows silently (no qty.float, no value, no symbol)", () => {
    const response: ZerionPositionsResponse = {
      data: [
        // no quantity.float
        { id: "bad1", type: "positions",
          attributes: { value: 100, fungible_info: { symbol: "X", implementations: [{ chain_id: "ethereum", address: "0x" }] } },
          relationships: { chain: { data: { id: "ethereum" } }, fungible: { data: { id: "f-x" } } } },
        // no value
        { id: "bad2", type: "positions",
          attributes: { quantity: { float: 1 }, fungible_info: { symbol: "Y", implementations: [{ chain_id: "ethereum", address: "0x" }] } },
          relationships: { chain: { data: { id: "ethereum" } }, fungible: { data: { id: "f-y" } } } },
        // no symbol
        { id: "bad3", type: "positions",
          attributes: { quantity: { float: 1 }, value: 100, fungible_info: { implementations: [{ chain_id: "ethereum", address: "0x" }] } },
          relationships: { chain: { data: { id: "ethereum" } }, fungible: { data: { id: "f-z" } } } },
        // NaN value
        { id: "bad4", type: "positions",
          attributes: { quantity: { float: 1 }, value: NaN, fungible_info: { symbol: "N", implementations: [{ chain_id: "ethereum", address: "0x" }] } },
          relationships: { chain: { data: { id: "ethereum" } }, fungible: { data: { id: "f-n" } } } },
        // valid
        pos({ symbol: "OK", chain: "ethereum", fungibleId: "f-ok", qty: 1, value: 100 }),
      ],
    };
    const result = mapPositions(response, {
      address: ADDR_LOWER,
      asOf: "2023-11-25",
      minValueUsd: 1.0,
    });
    const ops = [...result.ops];
    expect(ops).toHaveLength(2);  // 1 acct + 1 snapshot
    expect((ops[1] as { draft: { symbol: string } }).draft.symbol).toBe("OK");
  });

  test("price_usd is null when quantity is zero (would divide by zero)", () => {
    const response: ZerionPositionsResponse = {
      data: [{
        id: "p",
        type: "positions",
        attributes: {
          quantity: { float: 0 },
          value: 0,
          fungible_info: { symbol: "Z", implementations: [{ chain_id: "ethereum", address: "0xz" }] },
        },
        relationships: { chain: { data: { id: "ethereum" } }, fungible: { data: { id: "f-z" } } },
      }],
    };
    const result = mapPositions(response, {
      address: ADDR_LOWER,
      asOf: "2023-11-25",
      minValueUsd: 0,  // disable floor so the row survives
    });
    const ops = [...result.ops];
    expect(ops[1]!.kind).toBe("position_snapshot");
    expect((ops[1] as { draft: { price_usd: number | null } }).draft.price_usd).toBeNull();
  });

  test("display_name uses truncated address suffix", () => {
    const response: ZerionPositionsResponse = {
      data: [pos({ symbol: "ETH", chain: "ethereum", fungibleId: "f-eth", qty: 1, value: 2000 })],
    };
    const result = mapPositions(response, {
      address: ADDR_LOWER,
      asOf: "2023-11-25",
      minValueUsd: 1.0,
    });
    const ops = [...result.ops];
    // Expect "Zerion ethereum 0xabcd…ef01"
    expect((ops[0] as { draft: { display_name: string } }).draft.display_name).toBe(
      "Zerion ethereum 0xabcd…ef01",
    );
  });
});

import { mapWalletChart, mapFungiblePrices } from "../../src/zerion/mapper";
import type { ZerionChartResponse, ZerionFungibleChartResponse } from "../../src/zerion/client";

describe("mapWalletChart", () => {
  const ACCOUNT_ID = `zerion:ethereum:${ADDR_LOWER}`;

  test("yields one assertion op per [ts, value] pair, dates formatted UTC", () => {
    const response: ZerionChartResponse = {
      data: { attributes: { points: [
        [1700000000, 12345.67],   // 2023-11-14
        [1700604800, 12500.10],   // 2023-11-21
      ] } },
    };
    const ops = [...mapWalletChart(response, ACCOUNT_ID, "zerion-chart")];
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      kind: "assertion",
      draft: {
        account_id: ACCOUNT_ID,
        as_of: "2023-11-14",
        expected_usd: 12345.67,
        source: "zerion-chart",
      },
    });
    expect((ops[1] as { draft: { as_of: string; expected_usd: number } }).draft.as_of).toBe("2023-11-21");
    expect((ops[1] as { draft: { as_of: string; expected_usd: number } }).draft.expected_usd).toBe(12500.10);
  });

  test("drops non-finite or negative values silently", () => {
    const response: ZerionChartResponse = {
      data: { attributes: { points: [
        [1700000000, 100],     // OK
        [1700604800, NaN],     // dropped
        [1701209600, -50],     // dropped (negative wallet balance is nonsense)
        [1701814400, 200],     // OK
      ] } },
    };
    const ops = [...mapWalletChart(response, ACCOUNT_ID, "zerion-chart")];
    expect(ops).toHaveLength(2);
    expect((ops[0] as { draft: { expected_usd: number } }).draft.expected_usd).toBe(100);
    expect((ops[1] as { draft: { expected_usd: number } }).draft.expected_usd).toBe(200);
  });

  test("empty points → zero ops", () => {
    const response: ZerionChartResponse = {
      data: { attributes: { points: [] } },
    };
    const ops = [...mapWalletChart(response, ACCOUNT_ID, "zerion-chart")];
    expect(ops).toEqual([]);
  });
});

describe("mapFungiblePrices", () => {
  test("fans out one asset_price op per (point × implementation)", () => {
    const response: ZerionFungibleChartResponse = {
      data: {
        attributes: {
          symbol: "USDC",
          implementations: [
            { chain_id: "ethereum", address: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48" },
            { chain_id: "base",     address: null },  // native USDbC etc.
          ],
          points: [
            [1700000000, 1.0001],   // 2023-11-14
            [1700604800, 1.0002],   // 2023-11-21
          ],
        },
      },
    };
    const ops = [...mapFungiblePrices(response)];
    // 2 points × 2 implementations = 4 ops, interleaved per-point
    expect(ops).toHaveLength(4);

    expect(ops[0]).toEqual({
      kind: "asset_price",
      draft: {
        chain: "ethereum",
        contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",  // lowercased
        symbol: "USDC",
        as_of: "2023-11-14",
        source: "zerion",
        price_usd: 1.0001,
      },
    });
    expect(ops[1]).toEqual({
      kind: "asset_price",
      draft: {
        chain: "base",
        contract_address: null,
        symbol: "USDC",
        as_of: "2023-11-14",
        source: "zerion",
        price_usd: 1.0001,
      },
    });
    expect((ops[2] as { draft: { as_of: string; chain: string } }).draft.as_of).toBe("2023-11-21");
    expect((ops[2] as { draft: { as_of: string; chain: string } }).draft.chain).toBe("ethereum");
    expect((ops[3] as { draft: { as_of: string; chain: string } }).draft.chain).toBe("base");
  });

  test("emits a sync_warning (no_implementations) and no asset_price ops when implementations is empty", () => {
    const response: ZerionFungibleChartResponse = {
      data: {
        attributes: {
          symbol: "ORPHAN",
          implementations: [],
          points: [[1700000000, 5]],
        },
      },
    };
    const ops = [...mapFungiblePrices(response)];
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("sync_warning");
    expect((ops[0] as { warning: { source: string; scope: string | null; message: string } }).warning).toEqual({
      source: "zerion",
      scope: "no_implementations",
      message: "fungible ORPHAN has no implementations",
      detail: { symbol: "ORPHAN" },
    } as never);
  });

  test("drops malformed price points silently (NaN, non-positive)", () => {
    const response: ZerionFungibleChartResponse = {
      data: {
        attributes: {
          symbol: "ETH",
          implementations: [{ chain_id: "ethereum", address: null }],
          points: [
            [1700000000, 2500],    // OK
            [1700604800, NaN],     // dropped
            [1701209600, 0],       // dropped (price cannot be 0)
            [1701814400, -1],      // dropped
            [1702419200, 2600],    // OK
          ],
        },
      },
    };
    const ops = [...mapFungiblePrices(response)];
    expect(ops).toHaveLength(2);
    expect((ops[0] as { draft: { price_usd: number; as_of: string } }).draft.price_usd).toBe(2500);
    expect((ops[1] as { draft: { price_usd: number; as_of: string } }).draft.price_usd).toBe(2600);
  });

  test("empty points + non-empty implementations → zero ops, no warning", () => {
    const response: ZerionFungibleChartResponse = {
      data: {
        attributes: {
          symbol: "X",
          implementations: [{ chain_id: "ethereum", address: "0xx" }],
          points: [],
        },
      },
    };
    const ops = [...mapFungiblePrices(response)];
    expect(ops).toEqual([]);
  });
});
