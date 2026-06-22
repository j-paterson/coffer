import { describe, expect, test } from "bun:test";
import { AlchemyConfig } from "../../src/alchemy/config";

describe("AlchemyConfig", () => {
  test("parses an empty object using all defaults", () => {
    const cfg = AlchemyConfig.parse({});
    expect(cfg.api_key_env).toBe("ALCHEMY_API_KEY");
    expect(cfg.wallets).toEqual([]);
    expect(cfg.chains).toEqual(["ethereum", "base", "polygon", "optimism", "arbitrum"]);
    expect(cfg.metadata_cache_ttl_seconds).toBe(2592000);
  });

  test("accepts a valid lowercase EVM address", () => {
    const cfg = AlchemyConfig.parse({
      wallets: ["0xabcdef0123456789abcdef0123456789abcdef01"],
    });
    expect(cfg.wallets).toHaveLength(1);
    expect(cfg.wallets[0]).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  test("accepts a valid mixed-case EVM address (case is preserved)", () => {
    const cfg = AlchemyConfig.parse({
      wallets: ["0xABCDEF0123456789abcdef0123456789ABCDEF01"],
    });
    expect(cfg.wallets[0]).toBe("0xABCDEF0123456789abcdef0123456789ABCDEF01");
  });

  test("rejects malformed wallet addresses", () => {
    expect(() => AlchemyConfig.parse({ wallets: ["not-an-address"] })).toThrow();
    expect(() => AlchemyConfig.parse({ wallets: ["0x123"] })).toThrow();
    expect(() => AlchemyConfig.parse({ wallets: ["abcdef0123456789abcdef0123456789abcdef01"] }))
      .toThrow(); // missing 0x prefix
    expect(() => AlchemyConfig.parse({ wallets: ["0x" + "a".repeat(41)] })).toThrow(); // too long
    expect(() => AlchemyConfig.parse({ wallets: ["0x" + "z".repeat(40)] })).toThrow(); // non-hex chars
  });

  test("accepts a subset of chains", () => {
    const cfg = AlchemyConfig.parse({ chains: ["ethereum", "base"] });
    expect(cfg.chains).toEqual(["ethereum", "base"]);
  });

  test("rejects unknown chains", () => {
    expect(() => AlchemyConfig.parse({ chains: ["solana"] })).toThrow();
  });

  test("rejects zero or negative TTLs", () => {
    expect(() => AlchemyConfig.parse({ metadata_cache_ttl_seconds: 0 })).toThrow();
    expect(() => AlchemyConfig.parse({ metadata_cache_ttl_seconds: -1 })).toThrow();
  });

  test("rejects unknown keys (strict mode)", () => {
    expect(() => AlchemyConfig.parse({ unexpected_key: "x" } as unknown))
      .toThrow();
  });
});
