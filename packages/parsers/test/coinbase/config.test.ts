import { describe, expect, test } from "bun:test";
import { CoinbaseConfig, DEFAULT_CHAIN_MAP } from "../../src/coinbase/config";

describe("CoinbaseConfig — defaults", () => {
  test("applies all defaults on empty input", () => {
    const cfg = CoinbaseConfig.parse({});
    expect(cfg.key_name_env).toBe("COINBASE_KEY_NAME");
    expect(cfg.private_key_env).toBe("COINBASE_PRIVATE_KEY");
    expect(cfg.rate_per_minute).toBe(1500);
    expect(cfg.accounts_cache_ttl_seconds).toBe(300);
    expect(cfg.chain_map).toEqual({});
  });

  test("accepts overrides", () => {
    const cfg = CoinbaseConfig.parse({
      key_name_env: "MY_KEY",
      private_key_env: "MY_PEM",
      rate_per_minute: 60,
      accounts_cache_ttl_seconds: 0,
      chain_map: { FOO: "bar" },
    });
    expect(cfg.key_name_env).toBe("MY_KEY");
    expect(cfg.private_key_env).toBe("MY_PEM");
    expect(cfg.rate_per_minute).toBe(60);
    expect(cfg.accounts_cache_ttl_seconds).toBe(0);
    expect(cfg.chain_map).toEqual({ FOO: "bar" });
  });
});

describe("CoinbaseConfig — validation", () => {
  test("rejects non-positive rate_per_minute", () => {
    expect(() => CoinbaseConfig.parse({ rate_per_minute: 0 })).toThrow();
    expect(() => CoinbaseConfig.parse({ rate_per_minute: -1 })).toThrow();
  });

  test("rejects negative accounts_cache_ttl_seconds", () => {
    expect(() => CoinbaseConfig.parse({ accounts_cache_ttl_seconds: -1 })).toThrow();
  });

  test("rejects unknown top-level keys (.strict)", () => {
    expect(() => CoinbaseConfig.parse({ extra: 1 })).toThrow();
  });
});

describe("DEFAULT_CHAIN_MAP", () => {
  test("covers the 10 documented currencies", () => {
    expect(DEFAULT_CHAIN_MAP).toEqual({
      BTC:   "bitcoin",
      ETH:   "ethereum",
      USDC:  "ethereum",
      USDT:  "ethereum",
      SOL:   "solana",
      MATIC: "polygon",
      AVAX:  "avalanche",
      LINK:  "ethereum",
      DAI:   "ethereum",
      LTC:   "litecoin",
    });
  });
});
