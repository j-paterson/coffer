import { describe, expect, test } from "bun:test";
import { GeckoTerminalConfig, GeckoTerminalTarget, DEFAULT_CHAIN_SLUGS } from "../../src/geckoterminal/config";

describe("GeckoTerminalTarget", () => {
  test("accepts a minimal target", () => {
    const t = GeckoTerminalTarget.parse({
      symbol: "USDC",
      chain: "ethereum",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    });
    expect(t.symbol).toBe("USDC");
    expect(t.from).toBeUndefined();
    expect(t.to).toBeUndefined();
  });

  test("rejects empty symbol", () => {
    expect(() => GeckoTerminalTarget.parse({
      symbol: "",
      chain: "ethereum",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    })).toThrow();
  });

  test("rejects contract that is not 0x + 40 hex chars", () => {
    expect(() => GeckoTerminalTarget.parse({
      symbol: "X", chain: "ethereum", contract: "0xabc",
    })).toThrow();
    expect(() => GeckoTerminalTarget.parse({
      symbol: "X", chain: "ethereum", contract: "0xZZZ86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    })).toThrow();
    expect(() => GeckoTerminalTarget.parse({
      symbol: "X", chain: "ethereum",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800",
    })).toThrow();
  });

  test("rejects from/to that are not YYYY-MM-DD", () => {
    expect(() => GeckoTerminalTarget.parse({
      symbol: "X", chain: "ethereum",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      from: "2024/01/01",
    })).toThrow();
  });

  test("rejects unknown keys (.strict)", () => {
    expect(() => GeckoTerminalTarget.parse({
      symbol: "X", chain: "ethereum",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      extra: 1,
    })).toThrow();
  });
});

describe("GeckoTerminalConfig", () => {
  const VALID_TARGET = {
    symbol: "USDC",
    chain: "ethereum",
    contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  };

  test("applies defaults", () => {
    const cfg = GeckoTerminalConfig.parse({ targets: [VALID_TARGET] });
    expect(cfg.chain_slugs).toEqual({});
    expect(cfg.pool_cache_ttl_seconds).toBe(604_800);
    expect(cfg.rate_per_minute).toBe(28);
  });

  test("requires at least one target", () => {
    expect(() => GeckoTerminalConfig.parse({ targets: [] })).toThrow();
  });

  test("rejects non-positive rate_per_minute", () => {
    expect(() => GeckoTerminalConfig.parse({
      targets: [VALID_TARGET], rate_per_minute: 0,
    })).toThrow();
    expect(() => GeckoTerminalConfig.parse({
      targets: [VALID_TARGET], rate_per_minute: -1,
    })).toThrow();
  });

  test("rejects unknown top-level keys (.strict)", () => {
    expect(() => GeckoTerminalConfig.parse({
      targets: [VALID_TARGET], extra: 1,
    })).toThrow();
  });

  test("DEFAULT_CHAIN_SLUGS covers the 9 documented chains", () => {
    expect(DEFAULT_CHAIN_SLUGS).toEqual({
      ethereum:  "eth",
      base:      "base",
      optimism:  "optimism",
      arbitrum:  "arbitrum",
      polygon:   "polygon_pos",
      avalanche: "avax",
      scroll:    "scroll",
      unichain:  "unichain",
      zora:      "zora",
    });
  });
});
