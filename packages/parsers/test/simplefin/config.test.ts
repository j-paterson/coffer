import { describe, expect, test } from "bun:test";
import { SimpleFinConfig } from "../../src/simplefin/config";

describe("SimpleFinConfig", () => {
  test("parses an empty object using all defaults", () => {
    const cfg = SimpleFinConfig.parse({});
    expect(cfg.access_url_env).toBe("SIMPLEFIN_ACCESS_URL");
    expect(cfg.lookback_days).toBe(90);
    expect(cfg.include_pending).toBe(false);
    expect(cfg.account_overrides).toEqual({});
  });

  test("accepts partial account_overrides (each field optional)", () => {
    const cfg = SimpleFinConfig.parse({
      account_overrides: {
        "acct-a": { type: "credit" },
        "acct-b": { display_name: "Joint Checking" },
        "acct-c": { institution: "U.S. Bank" },
        "acct-d": { type: "savings", display_name: "HYSA", institution: "Ally" },
      },
    });
    expect(cfg.account_overrides["acct-a"]).toEqual({ type: "credit" });
    expect(cfg.account_overrides["acct-b"]).toEqual({ display_name: "Joint Checking" });
    expect(cfg.account_overrides["acct-d"]).toEqual({
      type: "savings", display_name: "HYSA", institution: "Ally",
    });
  });

  test("rejects non-positive lookback_days", () => {
    expect(() => SimpleFinConfig.parse({ lookback_days: 0 })).toThrow();
    expect(() => SimpleFinConfig.parse({ lookback_days: -5 })).toThrow();
    expect(() => SimpleFinConfig.parse({ lookback_days: 1.5 })).toThrow();
  });

  test("accepts large lookback_days values", () => {
    const cfg = SimpleFinConfig.parse({ lookback_days: 365 });
    expect(cfg.lookback_days).toBe(365);
  });
});
