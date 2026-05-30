import { describe, expect, test } from "bun:test";
import { InMemoryParserCache } from "../src/types/cache";

describe("InMemoryParserCache", () => {
  test("get returns null for unknown keys", async () => {
    const c = new InMemoryParserCache();
    expect(await c.get("nope")).toBeNull();
  });

  test("set then get round-trips a JSON-serializable value", async () => {
    const c = new InMemoryParserCache();
    await c.set("k", { foo: "bar", n: 1 });
    expect(await c.get<{ foo: string; n: number }>("k")).toEqual({ foo: "bar", n: 1 });
  });

  test("delete removes the key", async () => {
    const c = new InMemoryParserCache();
    await c.set("k", "v");
    await c.delete("k");
    expect(await c.get("k")).toBeNull();
  });

  test("set without ttl never expires", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const c = new InMemoryParserCache(() => now);
    await c.set("k", "v");
    now = new Date("2027-01-01T00:00:00Z");
    expect(await c.get<string>("k")).toBe("v");
  });

  test("set with ttl returns value before expiry", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const c = new InMemoryParserCache(() => now);
    await c.set("k", "v", 60);
    now = new Date(now.getTime() + 30_000);
    expect(await c.get<string>("k")).toBe("v");
  });

  test("set with ttl returns null after expiry", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const c = new InMemoryParserCache(() => now);
    await c.set("k", "v", 60);
    now = new Date(now.getTime() + 61_000);
    expect(await c.get<string>("k")).toBeNull();
  });
});
