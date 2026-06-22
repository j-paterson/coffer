import { describe, expect, test } from "bun:test";
import { DefiLlamaConfig, DefiLlamaTarget } from "../../src/defillama/config";

describe("DefiLlamaConfig", () => {
  test("parses an empty object using all defaults", () => {
    const cfg = DefiLlamaConfig.parse({});
    expect(cfg.targets).toEqual([]);
    expect(cfg.cg_overrides).toEqual({});
    expect(cfg.floor_date).toBe("2017-01-01");
    expect(cfg.base_url).toBe("https://coins.llama.fi");
  });

  test("parses targets with chain+contract+since populated", () => {
    const cfg = DefiLlamaConfig.parse({
      targets: [
        { symbol: "USDC", chain: "ethereum", contract: "0xa0b8...", since: "2026-05-01" },
        { symbol: "ETH" },  // chain/contract/since default to null
      ],
    });
    expect(cfg.targets).toHaveLength(2);
    expect(cfg.targets[0]).toEqual({
      symbol: "USDC", chain: "ethereum", contract: "0xa0b8...", since: "2026-05-01",
    });
    expect(cfg.targets[1]).toEqual({
      symbol: "ETH", chain: null, contract: null, since: null,
    });
  });

  test("rejects malformed since dates", () => {
    expect(() => DefiLlamaTarget.parse({ symbol: "ETH", since: "2026-5-1" })).toThrow();
    expect(() => DefiLlamaTarget.parse({ symbol: "ETH", since: "not-a-date" })).toThrow();
    expect(() => DefiLlamaTarget.parse({ symbol: "ETH", since: "2026-05-01T00:00:00Z" })).toThrow();
  });

  test("cg_overrides accepts string-or-null values", () => {
    const cfg = DefiLlamaConfig.parse({
      cg_overrides: {
        LDO: "lido-dao",   // extend
        ETH: null,          // suppress
      },
    });
    expect(cfg.cg_overrides.LDO).toBe("lido-dao");
    expect(cfg.cg_overrides.ETH).toBeNull();
  });

  test("rejects malformed floor_date", () => {
    expect(() => DefiLlamaConfig.parse({ floor_date: "2017" })).toThrow();
    expect(() => DefiLlamaConfig.parse({ floor_date: "01-01-2017" })).toThrow();
  });
});
