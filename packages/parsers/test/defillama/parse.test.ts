import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { syncDefiLlama } from "../../src/defillama/parse";
import { DefiLlamaConfig } from "../../src/defillama/config";
import { buildContext } from "../../src/context";
import { ConsoleLogger } from "../../src/types/logger";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";

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

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = resolve(import.meta.dir, "../fixtures/defillama");

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

async function collect(
  ctx: Parameters<typeof syncDefiLlama>[0],
): Promise<Operation[]> {
  const ops: Operation[] = [];
  for await (const op of syncDefiLlama(ctx)) ops.push(op);
  return ops;
}

function makeCtx(opts: {
  config: ReturnType<typeof DefiLlamaConfig.parse>;
  fetchJson: FetchJson;
  now?: Date;
}) {
  const ctx = buildContext({
    config: opts.config,
    logger: new ConsoleLogger(SILENT_SINK),
    now: () => opts.now ?? new Date("2023-11-25T00:00:00Z"),
  });
  (ctx as { fetchJson: FetchJson }).fetchJson = opts.fetchJson;
  return ctx;
}

describe("syncDefiLlama", () => {
  test("empty targets → 0 ops, 0 warnings, 0 HTTP calls", async () => {
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const ctx = makeCtx({ config: DefiLlamaConfig.parse({}), fetchJson });
    const ops = await collect(ctx);
    expect(ops).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("single-coin happy path: one call, three asset_price ops", async () => {
    const fixture = await loadFixture("single-chunk.json");
    const { fetchJson, calls } = stubFetchJson(() => fixture);
    // single-chunk last ts = 1700172800 → nextStart = 1700259200.
    // Set endUnix = 1700259200 so the walker halts after one call.
    const ctx = makeCtx({
      config: DefiLlamaConfig.parse({
        targets: [{ symbol: "ETH", since: "2023-11-14" }],
      }),
      fetchJson,
      now: new Date(1700259200 * 1000),
    });
    const ops = await collect(ctx);

    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toContain("/chart/coingecko%3Aethereum");
    expect(String(calls[0]!.url)).toContain("start=1699920000");  // 2023-11-14T00:00:00Z = 1699920000
    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({
      kind: "asset_price",
      draft: {
        chain: "",
        contract_address: null,
        symbol: "ETH",
        as_of: "2023-11-14",
        source: "defillama",
        price_usd: 2500.0,
      },
    });
    expect(ops[2]!.kind).toBe("asset_price");
    if (ops[2]!.kind === "asset_price") {
      expect(ops[2]!.draft.as_of).toBe("2023-11-16");
    }
  });

  test("multi-chunk walker: continues after chunk-a, terminates after chunk-b", async () => {
    const chunkA = await loadFixture("multi-chunk-a.json");
    const chunkB = await loadFixture("multi-chunk-b.json");

    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("start=1699920000")) return chunkA;  // 2023-11-14T00:00:00Z = 1699920000
      if (url.includes("start=1700432000")) return chunkB;
      throw new Error(`unexpected start in URL: ${url}`);
    });

    const ctx = makeCtx({
      config: DefiLlamaConfig.parse({
        targets: [
          { symbol: "ETH", since: null },  // null → floor_date
        ],
        floor_date: "2023-11-14",
      }),
      fetchJson,
      now: new Date(1700864000 * 1000),  // nextStart after chunkB = 1700864000 → endUnix = nextStart → halts
    });

    const ops = await collect(ctx);
    expect(calls).toHaveLength(2);              // walked exactly twice
    expect(ops).toHaveLength(10);               // 5 + 5 points × 1 identity
    expect(ops.every((op) => op.kind === "asset_price")).toBe(true);
  });

  test("unresolved target → 1 sync_warning, no HTTP call for it", async () => {
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called for unresolved target");
    });
    const ctx = makeCtx({
      config: DefiLlamaConfig.parse({
        targets: [{ symbol: "OBSCURE", chain: null, contract: null }],
      }),
      fetchJson,
    });
    const ops = await collect(ctx);
    expect(calls).toHaveLength(0);
    expect(ops).toEqual([
      {
        kind: "sync_warning",
        warning: {
          source: "defillama",
          scope: "unresolved_target",
          message: "OBSCURE (no-chain) has no DefiLlama coin key",
          detail: { symbol: "OBSCURE", chain: null, contract: null },
        },
      },
    ]);
  });

  test("per-coin HTTP error → fetch_failed warning, continues to next group", async () => {
    const fixture = await loadFixture("single-chunk.json");
    const { fetchJson } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("coingecko%3Aethereum")) throw new Error("503 Service Unavailable");
      if (url.includes("coingecko%3Abitcoin")) return fixture;
      throw new Error(`unexpected url: ${url}`);
    });
    // single-chunk last ts = 1700172800 → nextStart = 1700259200.
    // Set endUnix = 1700259200 so the BTC walker halts after one call.
    const ctx = makeCtx({
      config: DefiLlamaConfig.parse({
        targets: [
          { symbol: "ETH", since: "2023-11-14" },
          { symbol: "BTC", since: "2023-11-14" },
        ],
      }),
      fetchJson,
      now: new Date(1700259200 * 1000),
    });
    const ops = await collect(ctx);

    const warnings = ops.filter((op) => op.kind === "sync_warning");
    const prices = ops.filter((op) => op.kind === "asset_price");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "sync_warning",
      warning: {
        source: "defillama",
        scope: "fetch_failed",
        detail: { coinKey: "coingecko:ethereum" },
      },
    });
    // BTC still got its 3 ops despite ETH failing.
    expect(prices).toHaveLength(3);
    expect(prices.every((op) => op.kind === "asset_price" && op.draft.symbol === "BTC")).toBe(true);
  });

  test("empty response → no_data warning, no asset_price ops for that group", async () => {
    const empty = await loadFixture("empty.json");
    const { fetchJson } = stubFetchJson(() => empty);
    const ctx = makeCtx({
      config: DefiLlamaConfig.parse({
        targets: [{ symbol: "ETH", since: "2023-11-14" }],
      }),
      fetchJson,
    });
    const ops = await collect(ctx);
    expect(ops).toEqual([
      {
        kind: "sync_warning",
        warning: {
          source: "defillama",
          scope: "no_data",
          message: "no prices returned for coingecko:ethereum",
          detail: { coinKey: "coingecko:ethereum" },
        },
      },
    ]);
  });

  test("walker halts at endUnix even when response would have more points", async () => {
    // chunk-a alone is enough: its last ts is Day 5 (1700345600).
    // nextStart = 1700432000. If endUnix is set to 1700432000 (Day 6),
    // the walker should stop after one call (nextStart >= endUnix).
    const chunkA = await loadFixture("multi-chunk-a.json");
    const { fetchJson, calls } = stubFetchJson(() => chunkA);
    const ctx = makeCtx({
      config: DefiLlamaConfig.parse({
        targets: [{ symbol: "ETH", since: "2023-11-14" }],
      }),
      fetchJson,
      now: new Date(1700432000 * 1000),  // exactly Day 6 → endUnix = 1700432000
    });
    await collect(ctx);
    expect(calls).toHaveLength(1);  // did not walk to a second chunk
  });
});
