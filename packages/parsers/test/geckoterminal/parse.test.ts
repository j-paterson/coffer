import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { syncGeckoTerminal } from "../../src/geckoterminal/parse";
import { GeckoTerminalConfig } from "../../src/geckoterminal/config";
import { buildContext } from "../../src/context";
import { InMemoryParserCache } from "../../src/types/cache";
import { ConsoleLogger } from "../../src/types/logger";
import { HttpStatusError } from "../../src/http/errors";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";
import type { SecretResolver } from "../../src/types/secrets";
import type { Operation } from "@coffer/ledger/runner";

const FIXTURES = resolve(import.meta.dir, "../fixtures/geckoterminal");
const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };

const ADDR = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

interface Captured {
  url: string | URL;
  opts: FetchJsonOpts | undefined;
}

function stubFetchJson(responder: (call: Captured) => unknown): {
  fetchJson: FetchJson;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchJson: FetchJson = async <T>(url: string | URL, opts?: FetchJsonOpts): Promise<T> => {
    const captured: Captured = { url, opts };
    calls.push(captured);
    return responder(captured) as T;
  };
  return { fetchJson, calls };
}

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

interface MakeCtxOpts {
  config: ReturnType<typeof GeckoTerminalConfig.parse>;
  fetchJson: FetchJson;
  cache?: InMemoryParserCache;
  now?: () => Date;
}

function makeCtx(opts: MakeCtxOpts) {
  const ctx = buildContext({
    config: opts.config,
    logger: new ConsoleLogger(SILENT_SINK),
    now: opts.now ?? (() => new Date("2024-05-15T12:00:00Z")),
    secrets: fixedSecrets({}),
    cache: opts.cache ?? new InMemoryParserCache(),
  });
  (ctx as { fetchJson: FetchJson }).fetchJson = opts.fetchJson;
  return ctx;
}

async function collectOps(stream: AsyncIterable<Operation>): Promise<Operation[]> {
  const out: Operation[] = [];
  for await (const op of stream) out.push(op);
  return out;
}

describe("syncGeckoTerminal happy path", () => {
  test("single target, single partial page → emits asset_price ops", async () => {
    const pools = await loadFixture("pools-single.json");
    const ohlcv = await loadFixture("ohlcv-partial-page.json");

    const { fetchJson, calls } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/"))  return ohlcv;
      throw new Error(`unexpected: ${c.url}`);
    });

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 1000, // burst large enough that nothing sleeps
    });
    const ctx = makeCtx({ config, fetchJson });

    const ops = await collectOps(syncGeckoTerminal(ctx));

    // 1 pool list + 1 ohlcv = 2 fetchJson calls
    expect(calls).toHaveLength(2);
    // 50 partial-page points, all unique dates, all close > 0 → 50 ops
    expect(ops).toHaveLength(50);
    expect(ops[0]!.kind).toBe("asset_price");
    expect((ops[0] as { draft: { symbol: string; source: string } }).draft.symbol).toBe("USDC");
    expect((ops[0] as { draft: { source: string } }).draft.source).toBe("geckoterminal");
  });

  test("pagination stops on terminal page (len < 1000)", async () => {
    const pools = await loadFixture("pools-single.json");
    const partial = await loadFixture("ohlcv-partial-page.json");

    const { fetchJson, calls } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/"))  return partial;
      throw new Error(`unexpected: ${c.url}`);
    });

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 1000,
    });
    const ctx = makeCtx({ config, fetchJson });
    await collectOps(syncGeckoTerminal(ctx));

    // 1 pool list + exactly 1 ohlcv call (terminal page) = 2 total
    expect(calls).toHaveLength(2);
  });

  test("pagination walks back when full page returned, then stops at from_ts", async () => {
    const pools = await loadFixture("pools-single.json");
    const full = await loadFixture("ohlcv-full-page.json") as {
      data: { attributes: { ohlcv_list: number[][] } };
    };
    const oldestTs = full.data.attributes.ohlcv_list[full.data.attributes.ohlcv_list.length - 1]![0]!;

    // After one full page, the oldest_ts will be (1715731200 - 999*86400) = 1629395200 (2021-08-19).
    // The next call's before_timestamp will be oldestTs. We respond with the SAME page
    // (it'll all be < from_ts so emit nothing and the loop must stop on the from_ts guard).
    let callsToOhlcv = 0;
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/")) {
        callsToOhlcv++;
        return full;
      }
      throw new Error(`unexpected: ${c.url}`);
    });

    // Set from = the day of oldestTs - 1 day, so the very first page's points all qualify
    // but the SECOND page's oldest_ts <= from_ts and the loop stops.
    const fromTs = oldestTs - 86400;
    const fromDate = new Date(fromTs * 1000).toISOString().slice(0, 10);
    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR, from: fromDate }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson });
    await collectOps(syncGeckoTerminal(ctx));

    // 1st ohlcv call returns full page (1000 points, len == 1000 so no terminal-page stop).
    // 2nd ohlcv call returns the same full page; its oldest_ts === before_timestamp ⇒ cycle guard stops walk.
    expect(callsToOhlcv).toBe(2);
  });

  test("pagination stops on cycle guard when oldest_ts >= before_timestamp", async () => {
    const pools = await loadFixture("pools-single.json");
    // Build a full page where the OLDEST ts (last element) is the same on every call.
    // Cycle guard fires on the 2nd call.
    const ohlcv_list: number[][] = [];
    const tsFixed = 1715731200;
    for (let i = 0; i < 1000; i++) ohlcv_list.push([tsFixed - i * 86400, 0, 0, 0, 1, 0]);
    const fixedPage = { data: { attributes: { ohlcv_list } } };

    let callsToOhlcv = 0;
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/")) {
        callsToOhlcv++;
        return fixedPage;
      }
      throw new Error(`unexpected: ${c.url}`);
    });
    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson });
    await collectOps(syncGeckoTerminal(ctx));

    expect(callsToOhlcv).toBe(2);
  });
});

describe("syncGeckoTerminal pool cache", () => {
  test("cache hit short-circuits the pool list lookup", async () => {
    const ohlcv = await loadFixture("ohlcv-partial-page.json");

    let poolListCalls = 0;
    let ohlcvCalls = 0;
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) { poolListCalls++; throw new Error("should not be called"); }
      if (String(c.url).includes("/ohlcv/"))  { ohlcvCalls++; return ohlcv; }
      throw new Error(`unexpected: ${c.url}`);
    });

    const cache = new InMemoryParserCache();
    await cache.set(
      `geckoterminal:pool:ethereum:${ADDR}`,
      { pool_address: "0xpool_cached" },
      3600,
    );

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson, cache });
    await collectOps(syncGeckoTerminal(ctx));

    expect(poolListCalls).toBe(0);
    expect(ohlcvCalls).toBe(1);
  });

  test("uses cached pool_address in the OHLCV URL", async () => {
    const ohlcv = await loadFixture("ohlcv-partial-page.json");
    const { fetchJson, calls } = stubFetchJson((c) => {
      if (String(c.url).includes("/ohlcv/")) return ohlcv;
      throw new Error(`unexpected: ${c.url}`);
    });

    const cache = new InMemoryParserCache();
    await cache.set(
      `geckoterminal:pool:ethereum:${ADDR}`,
      { pool_address: "0xCACHED_POOL" },
      3600,
    );

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson, cache });
    await collectOps(syncGeckoTerminal(ctx));

    expect(String(calls[0]!.url)).toContain("/pools/0xCACHED_POOL/ohlcv/");
  });

  test("cache miss writes the resolved pool_address to cache", async () => {
    const pools = await loadFixture("pools-aerodrome-token.json");
    const ohlcv = await loadFixture("ohlcv-partial-page.json");

    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/"))  return ohlcv;
      throw new Error(`unexpected: ${c.url}`);
    });

    const cache = new InMemoryParserCache();
    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "AERO", chain: "base", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson, cache });
    await collectOps(syncGeckoTerminal(ctx));

    // The middle entry (15.5M reserve) is the highest-liquidity pool.
    const cached = await cache.get<{ pool_address: string }>(
      `geckoterminal:pool:base:${ADDR}`,
    );
    expect(cached).toEqual({ pool_address: "0x1111222233334444555566667777888899990000" });
  });
});

describe("syncGeckoTerminal stale-404 recovery", () => {
  test("404 on cached pool → delete cache, re-resolve, continue", async () => {
    const pools = await loadFixture("pools-single.json");
    const ohlcv = await loadFixture("ohlcv-partial-page.json");

    let poolListCalls = 0;
    let ohlcvAttempt = 0;
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) { poolListCalls++; return pools; }
      if (String(c.url).includes("/ohlcv/")) {
        ohlcvAttempt++;
        if (ohlcvAttempt === 1) {
          throw new HttpStatusError("404 Not Found", {
            url: String(c.url), method: "GET", attempts: 1, status: 404, bodyExcerpt: "",
          });
        }
        return ohlcv;
      }
      throw new Error(`unexpected: ${c.url}`);
    });

    const cache = new InMemoryParserCache();
    await cache.set(
      `geckoterminal:pool:ethereum:${ADDR}`,
      { pool_address: "0xSTALE_POOL" },
      3600,
    );

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson, cache });
    const ops = await collectOps(syncGeckoTerminal(ctx));

    // 1 stale OHLCV (404) + 1 re-resolve pool list + 1 fresh OHLCV
    expect(poolListCalls).toBe(1);
    expect(ohlcvAttempt).toBe(2);
    // Stale cache entry should have been refreshed with the new pool.
    const reCached = await cache.get<{ pool_address: string }>(
      `geckoterminal:pool:ethereum:${ADDR}`,
    );
    expect(reCached).toEqual({ pool_address: "0xcafebabecafebabecafebabecafebabecafebabe" });
    // Recovery produced no warning; prices were delivered.
    expect(ops.filter((o) => o.kind === "sync_warning")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "asset_price").length).toBeGreaterThan(0);
  });

  test("404 again after re-resolve → emit ohlcv_failed and stop", async () => {
    const pools = await loadFixture("pools-single.json");

    let poolListCalls = 0;
    let ohlcvAttempt = 0;
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) { poolListCalls++; return pools; }
      if (String(c.url).includes("/ohlcv/")) {
        ohlcvAttempt++;
        throw new HttpStatusError("404 Not Found", {
          url: String(c.url), method: "GET", attempts: 1, status: 404, bodyExcerpt: "",
        });
      }
      throw new Error(`unexpected: ${c.url}`);
    });

    const cache = new InMemoryParserCache();
    await cache.set(
      `geckoterminal:pool:ethereum:${ADDR}`,
      { pool_address: "0xSTALE_POOL" },
      3600,
    );

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson, cache });
    const ops = await collectOps(syncGeckoTerminal(ctx));

    // Exactly one recovery attempt → 2 ohlcv calls, 1 pool list re-resolve.
    expect(poolListCalls).toBe(1);
    expect(ohlcvAttempt).toBe(2);
    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("ohlcv_failed");
  });
});

describe("syncGeckoTerminal error scopes", () => {
  test("pool_lookup_failed: network error on /tokens/ → 1 warning, target isolation", async () => {
    const pools = await loadFixture("pools-single.json");
    const ohlcv = await loadFixture("ohlcv-partial-page.json");
    const ADDR2 = "0xb0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

    let firstTokensSeen = false;
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) {
        if (!firstTokensSeen) {
          firstTokensSeen = true;
          throw new Error("network down");
        }
        return pools;
      }
      if (String(c.url).includes("/ohlcv/")) return ohlcv;
      throw new Error(`unexpected: ${c.url}`);
    });

    const config = GeckoTerminalConfig.parse({
      targets: [
        { symbol: "BAD", chain: "ethereum", contract: ADDR },
        { symbol: "OK",  chain: "ethereum", contract: ADDR2 },
      ],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson });
    const ops = await collectOps(syncGeckoTerminal(ctx));

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("pool_lookup_failed");
    expect(ops.filter((o) => o.kind === "asset_price").length).toBeGreaterThan(0);
  });

  test("no_pool: empty pool list → 1 warning, no prices", async () => {
    const empty = await loadFixture("pools-empty.json");
    const { fetchJson, calls } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return empty;
      throw new Error(`unexpected: ${c.url}`);
    });

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "NOPOOL", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson });
    const ops = await collectOps(syncGeckoTerminal(ctx));

    expect(calls).toHaveLength(1);
    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("no_pool");
    expect(ops.filter((o) => o.kind === "asset_price")).toHaveLength(0);
  });

  test("ohlcv_failed: non-404 error → 1 warning, no recovery, isolation", async () => {
    const pools = await loadFixture("pools-single.json");
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/")) {
        throw new HttpStatusError("502 Bad Gateway", {
          url: String(c.url), method: "GET", attempts: 1, status: 502, bodyExcerpt: "",
        });
      }
      throw new Error(`unexpected: ${c.url}`);
    });

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "FAIL", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson });
    const ops = await collectOps(syncGeckoTerminal(ctx));

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("ohlcv_failed");
  });

  test("unmapped chain → silent skip (no warning, no HTTP)", async () => {
    const { fetchJson, calls } = stubFetchJson(() => { throw new Error("should not be called"); });

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "X", chain: "weirdchain", contract: ADDR }],
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson });
    const ops = await collectOps(syncGeckoTerminal(ctx));

    expect(ops).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("chain_slugs config override adds a chain", async () => {
    const pools = await loadFixture("pools-single.json");
    const ohlcv = await loadFixture("ohlcv-partial-page.json");
    const { fetchJson, calls } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/"))  return ohlcv;
      throw new Error(`unexpected: ${c.url}`);
    });

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "LIN", chain: "linea", contract: ADDR }],
      chain_slugs: { linea: "linea" },
      rate_per_minute: 100000,
    });
    const ctx = makeCtx({ config, fetchJson });
    await collectOps(syncGeckoTerminal(ctx));

    expect(String(calls[0]!.url)).toContain("/networks/linea/tokens/");
  });
});

describe("syncGeckoTerminal token-bucket integration", () => {
  test("each HTTP request consumes one bucket token (verified via sleep injection)", async () => {
    const pools = await loadFixture("pools-single.json");
    const ohlcv = await loadFixture("ohlcv-partial-page.json");
    const { fetchJson } = stubFetchJson((c) => {
      if (String(c.url).includes("/tokens/")) return pools;
      if (String(c.url).includes("/ohlcv/"))  return ohlcv;
      throw new Error(`unexpected: ${c.url}`);
    });

    let clock = 0;
    const sleeps: number[] = [];
    const fakeNow = () => clock;
    const fakeSleep = async (ms: number) => { sleeps.push(ms); clock += ms; };

    const config = GeckoTerminalConfig.parse({
      targets: [{ symbol: "USDC", chain: "ethereum", contract: ADDR }],
      rate_per_minute: 60,
    });
    const ctx = makeCtx({ config, fetchJson });
    await collectOps(syncGeckoTerminal(ctx, {
      bucketOpts: { burst: 1, now: fakeNow, sleep: fakeSleep },
    }));

    expect(sleeps).toEqual([1000]);
  });
});
