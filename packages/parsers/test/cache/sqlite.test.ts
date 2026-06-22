import { describe, expect, test } from "bun:test";
import { SqliteParserCache } from "../../src/cache/sqlite";

describe("SqliteParserCache", () => {
  test("get returns null for unknown keys", async () => {
    const c = new SqliteParserCache(":memory:");
    expect(await c.get("nope")).toBeNull();
    c.close();
  });

  test("set then get round-trips a JSON value", async () => {
    const c = new SqliteParserCache(":memory:");
    await c.set("k", { foo: "bar", n: 1 });
    expect(await c.get<{ foo: string; n: number }>("k")).toEqual({ foo: "bar", n: 1 });
    c.close();
  });

  test("set replaces an existing value (upsert)", async () => {
    const c = new SqliteParserCache(":memory:");
    await c.set("k", { v: 1 });
    await c.set("k", { v: 2 });
    expect(await c.get<{ v: number }>("k")).toEqual({ v: 2 });
    c.close();
  });

  test("set without ttl persists indefinitely", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const c = new SqliteParserCache(":memory:", () => now);
    await c.set("k", "v");
    now = new Date("2030-01-01T00:00:00Z");
    expect(await c.get<string>("k")).toBe("v");
    c.close();
  });

  test("set with ttl returns value before expiry", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const c = new SqliteParserCache(":memory:", () => now);
    await c.set("k", "v", 60);
    now = new Date(now.getTime() + 30_000);
    expect(await c.get<string>("k")).toBe("v");
    c.close();
  });

  test("set with ttl returns null after expiry and deletes the row", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const c = new SqliteParserCache(":memory:", () => now);
    await c.set("k", "v", 60);
    now = new Date(now.getTime() + 61_000);
    expect(await c.get<string>("k")).toBeNull();
    // After read-through expiry, a second get is still null (not re-inserted).
    expect(await c.get<string>("k")).toBeNull();
    c.close();
  });

  test("delete removes the row", async () => {
    const c = new SqliteParserCache(":memory:");
    await c.set("k", "v");
    await c.delete("k");
    expect(await c.get<string>("k")).toBeNull();
    c.close();
  });

  test("re-opening a path-backed DB preserves rows", async () => {
    const path = `/tmp/parser-cache-test-${Date.now()}.sqlite`;
    const c1 = new SqliteParserCache(path);
    await c1.set("k", { v: 42 });
    c1.close();
    const c2 = new SqliteParserCache(path);
    expect(await c2.get<{ v: number }>("k")).toEqual({ v: 42 });
    c2.close();
    // Cleanup
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path);
  });
});
