import { describe, expect, test } from "bun:test";
import { ZerionConfig } from "../../src/zerion/config";

describe("ZerionConfig", () => {
  test("parses an empty object using all defaults", () => {
    const cfg = ZerionConfig.parse({});
    expect(cfg.api_key_env).toBe("ZERION_API_KEY");
    expect(cfg.base_url).toBe("https://api.zerion.io/v1");
    expect(cfg.wallets).toEqual([]);
    expect(cfg.min_value_usd).toBe(1.0);
    expect(cfg.chart_cache_ttl_seconds).toBe(86400);
  });

  test("accepts a valid lowercase EVM address", () => {
    const cfg = ZerionConfig.parse({
      wallets: ["0xabcdef0123456789abcdef0123456789abcdef01"],
    });
    expect(cfg.wallets).toHaveLength(1);
    expect(cfg.wallets[0]).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  test("accepts a valid mixed-case EVM address (case is preserved)", () => {
    const cfg = ZerionConfig.parse({
      wallets: ["0xABCDEF0123456789abcdef0123456789ABCDEF01"],
    });
    expect(cfg.wallets[0]).toBe("0xABCDEF0123456789abcdef0123456789ABCDEF01");
  });

  test("rejects malformed wallet addresses", () => {
    expect(() => ZerionConfig.parse({ wallets: ["not-an-address"] })).toThrow();
    expect(() => ZerionConfig.parse({ wallets: ["0xtooshort"] })).toThrow();
    expect(() => ZerionConfig.parse({ wallets: ["0x" + "z".repeat(40)] })).toThrow();
    // missing 0x prefix
    expect(() => ZerionConfig.parse({ wallets: ["a".repeat(40)] })).toThrow();
    // too long
    expect(() => ZerionConfig.parse({ wallets: ["0x" + "a".repeat(41)] })).toThrow();
  });

  test("rejects negative min_value_usd", () => {
    expect(() => ZerionConfig.parse({ min_value_usd: -1 })).toThrow();
  });

  test("accepts zero min_value_usd (disables the filter)", () => {
    const cfg = ZerionConfig.parse({ min_value_usd: 0 });
    expect(cfg.min_value_usd).toBe(0);
  });

  test("rejects non-positive chart_cache_ttl_seconds", () => {
    expect(() => ZerionConfig.parse({ chart_cache_ttl_seconds: 0 })).toThrow();
    expect(() => ZerionConfig.parse({ chart_cache_ttl_seconds: -1 })).toThrow();
  });

  test("rejects unknown keys (strict mode)", () => {
    expect(() => ZerionConfig.parse({ unknown_field: "x" })).toThrow();
  });

  test("rejects non-URL base_url", () => {
    expect(() => ZerionConfig.parse({ base_url: "not a url" })).toThrow();
  });
});
