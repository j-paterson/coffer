import { describe, expect, test } from "bun:test";
import { buildContext } from "../src/context";
import { ConsoleLogger } from "../src/types/logger";
import { InMemoryParserCache } from "../src/types/cache";
import { EnvSecretResolver } from "../src/secrets/env";
import { NullPriceProvider, MapPriceProvider } from "../src/types/price-provider";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };

describe("buildContext", () => {
  test("fills in defaults for optional fields", () => {
    const ctx = buildContext({ config: { a: 1 } });
    expect(ctx.config).toEqual({ a: 1 });
    expect(ctx.http).toBe(globalThis.fetch);
    expect(typeof ctx.fetchJson).toBe("function");
    expect(ctx.cache).toBeInstanceOf(InMemoryParserCache);
    expect(ctx.logger).toBeInstanceOf(ConsoleLogger);
    expect(ctx.secrets).toBeInstanceOf(EnvSecretResolver);
    expect(ctx.now()).toBeInstanceOf(Date);
  });

  test("respects overrides for every optional field", () => {
    const cache = new InMemoryParserCache();
    const logger = new ConsoleLogger(SILENT_SINK);
    const secrets = new EnvSecretResolver();
    const fixedNow = () => new Date("2026-05-11T00:00:00Z");
    const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const ctx = buildContext({
      config: { a: 1 },
      http: fakeFetch,
      cache,
      logger,
      secrets,
      now: fixedNow,
    });
    expect(ctx.http).toBe(fakeFetch);
    expect(ctx.cache).toBe(cache);
    expect(ctx.logger).toBe(logger);
    expect(ctx.secrets).toBe(secrets);
    expect(ctx.now()).toEqual(new Date("2026-05-11T00:00:00Z"));
  });

  test("retry override flows through to fetchJson", async () => {
    // Build a context with retries: 1 baked into the policy so we observe
    // that the override is merged into DEFAULT_RETRY.
    const calls: number[] = [];
    const fakeFetch = (async () => {
      calls.push(1);
      return new Response("oops", { status: 500 });
    }) as unknown as typeof fetch;
    const ctx = buildContext({
      config: {},
      http: fakeFetch,
      logger: new ConsoleLogger(SILENT_SINK),
      retry: { maxAttempts: 2 }, // 1 initial + 1 retry
    });
    let caught: unknown;
    try {
      await ctx.fetchJson("https://x.test/y");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(calls.length).toBe(2);
  });
});

describe("buildContext — priceProvider", () => {
  test("defaults priceProvider to NullPriceProvider", () => {
    const ctx = buildContext({ config: {} });
    expect(ctx.priceProvider).toBeInstanceOf(NullPriceProvider);
  });

  test("honors an injected priceProvider", () => {
    const provider = new MapPriceProvider({ "BTC:2024-01-01": 42 });
    const ctx = buildContext({ config: {}, priceProvider: provider });
    expect(ctx.priceProvider).toBe(provider);
  });
});
