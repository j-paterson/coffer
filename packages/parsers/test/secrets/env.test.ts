import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EnvSecretResolver } from "../../src/secrets/env";

describe("EnvSecretResolver", () => {
  const KEY = "FINANCE_TEST_SECRET_PHASE2";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("returns null when the env var is unset", async () => {
    const r = new EnvSecretResolver();
    expect(await r.get(KEY)).toBeNull();
  });

  test("returns the value when the env var is set", async () => {
    process.env[KEY] = "shhh";
    const r = new EnvSecretResolver();
    expect(await r.get(KEY)).toBe("shhh");
  });

  test("empty string is returned as-is (not coerced to null)", async () => {
    process.env[KEY] = "";
    const r = new EnvSecretResolver();
    expect(await r.get(KEY)).toBe("");
  });
});
