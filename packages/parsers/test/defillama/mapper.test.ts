import { describe, expect, test } from "bun:test";
import { buildCoinKey, DEFAULT_CG_MAP, expandPointsToOps, mergeCgMap, resolveTargets } from "../../src/defillama/mapper";

describe("DEFAULT_CG_MAP", () => {
  test("includes the major majors", () => {
    expect(DEFAULT_CG_MAP.ETH).toBe("ethereum");
    expect(DEFAULT_CG_MAP.BTC).toBe("bitcoin");
    expect(DEFAULT_CG_MAP.USDC).toBe("usd-coin");
    expect(DEFAULT_CG_MAP.WETH).toBe("weth");
    expect(DEFAULT_CG_MAP.WBTC).toBe("wrapped-bitcoin");
  });

  test("has exactly 31 entries (lifted verbatim from backfill_defillama.py)", () => {
    expect(Object.keys(DEFAULT_CG_MAP)).toHaveLength(31);
  });
});

describe("buildCoinKey", () => {
  test("returns <chain>:<contract> (lowercased) when both are present", () => {
    const key = buildCoinKey(
      { symbol: "USDC", chain: "Ethereum", contract: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48" },
      DEFAULT_CG_MAP,
    );
    expect(key).toBe("ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  });

  test("applies the chain alias (avalanche -> avax) when both are present", () => {
    const key = buildCoinKey(
      { symbol: "USDC", chain: "avalanche", contract: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e" },
      DEFAULT_CG_MAP,
    );
    expect(key).toBe("avax:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e");
  });

  test("falls back to coingecko:<id> when chain or contract is missing", () => {
    expect(buildCoinKey({ symbol: "ETH", chain: null, contract: null }, DEFAULT_CG_MAP))
      .toBe("coingecko:ethereum");
    expect(buildCoinKey({ symbol: "btc", chain: null, contract: null }, DEFAULT_CG_MAP))
      .toBe("coingecko:bitcoin");
    // empty strings should be treated as missing too
    expect(buildCoinKey({ symbol: "ETH", chain: "", contract: "" }, DEFAULT_CG_MAP))
      .toBe("coingecko:ethereum");
  });

  test("returns null when neither path resolves (no chain+contract AND symbol not in CG map)", () => {
    expect(buildCoinKey({ symbol: "OBSCURE", chain: null, contract: null }, DEFAULT_CG_MAP))
      .toBeNull();
    expect(buildCoinKey({ symbol: "OBSCURE", chain: "ethereum", contract: null }, DEFAULT_CG_MAP))
      .toBeNull();  // partial chain-only also fails
  });
});

describe("mergeCgMap", () => {
  test("retains all default entries when overrides is empty", () => {
    const merged = mergeCgMap({});
    expect(merged.ETH).toBe("ethereum");
    expect(merged.BTC).toBe("bitcoin");
    expect(Object.keys(merged)).toHaveLength(31);
  });

  test("extends with new entries (uppercased keys)", () => {
    const merged = mergeCgMap({ LDO: "lido-dao", AAVE: "aave" });
    expect(merged.LDO).toBe("lido-dao");
    expect(merged.AAVE).toBe("aave");
    expect(merged.ETH).toBe("ethereum");  // defaults preserved
    expect(Object.keys(merged)).toHaveLength(33);
  });

  test("suppresses a default when a lowercase override key is given (case-normalization)", () => {
    // Without case-normalization, `eth: null` would coexist with the
    // default `ETH: "ethereum"` and the lookup `merged["ETH"]` would
    // still hit the default. mergeCgMap must uppercase override keys.
    const merged = mergeCgMap({ eth: null });
    expect(merged.ETH).toBeNull();
    expect(Object.keys(merged)).toHaveLength(31);  // count stable
  });
});

describe("resolveTargets", () => {
  test("dedups multi-chain WETH into a single group, identities preserved", () => {
    // Both WETH targets lack a contract → both resolve to "coingecko:weth".
    // The single resulting group has 2 identities, one per (symbol, chain).
    const { groups, warnings } = resolveTargets(
      [
        { symbol: "WETH", chain: "ethereum", contract: null, since: "2026-05-01" },
        { symbol: "WETH", chain: "base",     contract: null, since: "2026-04-15" },
      ],
      "2017-01-01",
      mergeCgMap({}),
    );
    expect(warnings).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.coinKey).toBe("coingecko:weth");
    expect(groups[0]!.identities).toHaveLength(2);
    expect(groups[0]!.identities).toEqual(
      expect.arrayContaining([
        { symbol: "WETH", chain: "ethereum", contract: null },
        { symbol: "WETH", chain: "base",     contract: null },
      ]),
    );
    // since is min across identities
    expect(groups[0]!.since).toBe("2026-04-15");
  });

  test("emits one sync_warning per unresolved target and skips it (no group)", () => {
    const { groups, warnings } = resolveTargets(
      [
        { symbol: "ETH",     chain: null, contract: null, since: null },
        { symbol: "OBSCURE", chain: null, contract: null, since: null },
      ],
      "2017-01-01",
      mergeCgMap({}),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.coinKey).toBe("coingecko:ethereum");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      kind: "sync_warning",
      warning: {
        source: "defillama",
        scope: "unresolved_target",
        message: "OBSCURE (no-chain) has no DefiLlama coin key",
        detail: { symbol: "OBSCURE", chain: null, contract: null },
      },
    });
  });

  test("uses floor_date when a target's since is null; computes group.since as the min", () => {
    const { groups } = resolveTargets(
      [
        { symbol: "ETH", chain: null, contract: null, since: null },         // -> floor 2020-01-01
        { symbol: "ETH", chain: null, contract: null, since: "2023-06-15" }, // -> 2023-06-15
      ],
      "2020-01-01",
      mergeCgMap({}),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.since).toBe("2020-01-01");  // min of floor and 2023-06-15
  });
});

describe("expandPointsToOps", () => {
  test("fans out one asset_price op per (point × identity), formatting dates in UTC", () => {
    const group = {
      coinKey: "coingecko:weth",
      identities: [
        { symbol: "WETH", chain: "ethereum", contract: null },
        { symbol: "WETH", chain: "base",     contract: null },
      ],
      since: "2026-04-15",
    };
    const points = [
      { ts: 1700000000, price: 2500.0 },  // 2023-11-14
      { ts: 1700086400, price: 2510.0 },  // 2023-11-15
    ];
    const ops = [...expandPointsToOps(group, points)];

    expect(ops).toHaveLength(4);  // 2 points × 2 identities
    expect(ops[0]).toEqual({
      kind: "asset_price",
      draft: {
        chain: "ethereum",
        contract_address: null,
        symbol: "WETH",
        as_of: "2023-11-14",
        source: "defillama",
        price_usd: 2500.0,
      },
    });
    expect(ops[1]).toEqual({
      kind: "asset_price",
      draft: {
        chain: "base",
        contract_address: null,
        symbol: "WETH",
        as_of: "2023-11-14",
        source: "defillama",
        price_usd: 2500.0,
      },
    });
    expect((ops[2] as { draft: { as_of: string } }).draft.as_of).toBe("2023-11-15");
    expect((ops[3] as { draft: { as_of: string } }).draft.as_of).toBe("2023-11-15");
  });

  test("uses empty string for chain when identity.chain is null (matches Python convention)", () => {
    const group = {
      coinKey: "coingecko:bitcoin",
      identities: [{ symbol: "BTC", chain: null, contract: null }],
      since: "2017-01-01",
    };
    const ops = [...expandPointsToOps(group, [{ ts: 1700000000, price: 35000.0 }])];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      kind: "asset_price",
      draft: {
        chain: "",  // null identity.chain → "" to satisfy AssetPriceDraft.chain: string
        contract_address: null,
        symbol: "BTC",
        as_of: "2023-11-14",
        source: "defillama",
        price_usd: 35000.0,
      },
    });
  });
});
