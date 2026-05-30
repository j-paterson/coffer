import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { syncZerion } from "../../src/zerion/parse";
import { ZerionConfig } from "../../src/zerion/config";
import { buildContext } from "../../src/context";
import { ConsoleLogger } from "../../src/types/logger";
import { InMemoryParserCache } from "../../src/types/cache";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";
import type { SecretResolver } from "../../src/types/secrets";

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
const FIXTURES = resolve(import.meta.dir, "../fixtures/zerion");
const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

async function collect(
  ctx: Parameters<typeof syncZerion>[0],
): Promise<Operation[]> {
  const ops: Operation[] = [];
  for await (const op of syncZerion(ctx)) ops.push(op);
  return ops;
}

function makeCtx(opts: {
  config: ReturnType<typeof ZerionConfig.parse>;
  fetchJson: FetchJson;
  secrets?: Record<string, string | null>;
  now?: Date;
  cache?: InMemoryParserCache;
}) {
  const ctx = buildContext({
    config: opts.config,
    logger: new ConsoleLogger(SILENT_SINK),
    now: () => opts.now ?? new Date("2023-11-25T00:00:00Z"),
    secrets: fixedSecrets(opts.secrets ?? { ZERION_API_KEY: "test-key" }),
    cache: opts.cache ?? new InMemoryParserCache(),
  });
  (ctx as { fetchJson: FetchJson }).fetchJson = opts.fetchJson;
  return ctx;
}

describe("syncZerion — auth gate + empty wallets", () => {
  test("missing API key → single config warning, no HTTP", async () => {
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson,
      secrets: { ZERION_API_KEY: null },
    });
    const ops = await collect(ctx);
    expect(calls).toHaveLength(0);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("sync_warning");
    expect((ops[0] as { warning: { scope: string | null; message: string } }).warning.scope).toBe("config");
    expect((ops[0] as { warning: { scope: string | null; message: string } }).warning.message).toContain("ZERION_API_KEY");
  });

  test("empty wallets → zero ops, zero HTTP, zero warnings", async () => {
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const ctx = makeCtx({
      config: ZerionConfig.parse({}),  // wallets defaults to []
      fetchJson,
    });
    const ops = await collect(ctx);
    expect(ops).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("syncZerion — phase 1 (positions)", () => {
  test("single-wallet happy path: emits acct + snapshot ops for both chains, no charts (cache empty so phase 2/3 also fire — gate them with empty fixtures)", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const emptyChart = { data: { attributes: { points: [] } } };
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/")) return positions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return emptyChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson,
    });
    const ops = await collect(ctx);

    // Phase 1: 2 account_discovery (ethereum + base) + 3 position_snapshot
    const accounts = ops.filter((op) => op.kind === "account_discovery");
    const snapshots = ops.filter((op) => op.kind === "position_snapshot");
    expect(accounts).toHaveLength(2);
    expect(snapshots).toHaveLength(3);
    expect(snapshots.every((op) => op.kind === "position_snapshot" && op.draft.as_of === "2023-11-25")).toBe(true);

    // First HTTP call is the positions fetch
    expect(String(calls[0]!.url)).toContain(`/wallets/${ADDR}/positions/`);
  });

  test("per-wallet positions failure → 1 sync_warning, other wallets still produce ops", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const emptyChart = { data: { attributes: { points: [] } } };
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const ADDR_FAIL = "0x1111111111111111111111111111111111111111";
    const ADDR_OK   = ADDR;

    const { fetchJson } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes(`/wallets/${ADDR_FAIL}/positions/`)) {
        throw new Error("503 Service Unavailable");
      }
      if (url.includes(`/wallets/${ADDR_OK}/positions/`))   return positions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return emptyChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR_FAIL, ADDR_OK] }),
      fetchJson,
    });
    const ops = await collect(ctx);

    const warnings = ops.filter((op) => op.kind === "sync_warning");
    const snapshots = ops.filter((op) => op.kind === "position_snapshot");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string | null; detail: unknown } }).warning.scope)
      .toBe("positions_fetch_failed");
    expect(snapshots).toHaveLength(3);  // ADDR_OK still produced its 3 rows
  });

  test("empty positions response → no acct, no snapshot, no chart fetches for that wallet", async () => {
    const empty = await loadFixture("positions-empty.json");

    const { fetchJson, calls } = stubFetchJson(() => empty);

    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson,
    });
    const ops = await collect(ctx);
    expect(ops).toEqual([]);
    expect(calls).toHaveLength(1);  // only the positions fetch
  });
});

describe("syncZerion — phase 2 (wallet charts)", () => {
  test("emits assertion ops per (wallet, chain) chart point", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = await loadFixture("wallet-chart-year.json");
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/"))                   return positions;
      if (url.includes(`/wallets/${ADDR}/charts/year`))  return walletChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson,
    });
    const ops = await collect(ctx);

    // 2 (wallet, chain) pairs × 3 points each = 6 assertion ops
    const assertions = ops.filter((op) => op.kind === "assertion");
    expect(assertions).toHaveLength(6);
    expect(assertions.every((op) => op.kind === "assertion" && op.draft.source === "zerion-chart")).toBe(true);

    // Each (wallet, chain) made exactly one wallet-chart call
    const walletChartCalls = calls.filter((c) => {
      const u = String(c.url);
      return u.includes(`/wallets/${ADDR}/charts/year`);
    });
    expect(walletChartCalls).toHaveLength(2);
  });

  test("phase 2 uses ctx.cache: hit on second run skips HTTP", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = await loadFixture("wallet-chart-year.json");
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/"))                   return positions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return walletChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const cache = new InMemoryParserCache();
    const ctx1 = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson, cache,
    });
    await collect(ctx1);
    const callsAfterRun1 = calls.length;

    // Run 2 with the same cache — chart fetches should be skipped
    const ctx2 = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson, cache,
    });
    await collect(ctx2);
    const newCalls = calls.length - callsAfterRun1;

    // Expected new calls on run 2:
    //   1 positions fetch (NOT cached)
    //   0 wallet-chart fetches (BOTH cached)
    //   0 fungible-chart fetches (BOTH cached)
    expect(newCalls).toBe(1);
  });

  test("phase 2: cache key includes lowercased addr (mixed case in run 1 vs run 2 hits same key)", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = await loadFixture("wallet-chart-year.json");
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/"))                   return positions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return walletChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const cache = new InMemoryParserCache();
    const ADDR_MIXED = "0xABCDEF0123456789abcdef0123456789ABCDEF01";

    await collect(makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR_MIXED] }),
      fetchJson, cache,
    }));
    const callsAfterRun1 = calls.length;

    // Run 2 with the lowercased version — chart cache should still hit
    await collect(makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),  // lowercase
      fetchJson, cache,
    }));
    const newCalls = calls.length - callsAfterRun1;
    expect(newCalls).toBe(1);  // just the positions fetch
  });

  test("phase 2 fetch failure → 1 chart_fetch_failed warning, other (wallet,chain) pairs still process", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = await loadFixture("wallet-chart-year.json");
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/")) return positions;
      // fail the ethereum wallet chart
      if (url.includes("/charts/year") && url.includes("filter%5Bchain_ids%5D=ethereum")) {
        throw new Error("503 Service Unavailable");
      }
      if (url.includes("/charts/year") && url.includes("filter%5Bchain_ids%5D=base")) return walletChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson,
    });
    const ops = await collect(ctx);

    const warnings = ops.filter((op) => op.kind === "sync_warning");
    const assertions = ops.filter((op) => op.kind === "assertion");
    const chartWarn = warnings.find((w) =>
      (w as { warning: { scope: string | null } }).warning.scope === "chart_fetch_failed");
    expect(chartWarn).toBeDefined();
    expect((chartWarn as { warning: { detail: unknown } }).warning.detail).toEqual({
      addr: ADDR,
      chain: "ethereum",
    });
    // base wallet chart still produced 3 assertion ops
    expect(assertions).toHaveLength(3);
  });
});

describe("syncZerion — phase 3 (fungible prices)", () => {
  test("emits asset_price ops with identity fan-out, dedup across wallets", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = { data: { attributes: { points: [] } } };
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/"))                   return positions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return walletChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    // Two wallets — should still only fetch each fungible chart ONCE (dedup)
    const ADDR_B = "0x1111111111111111111111111111111111111111";
    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR, ADDR_B] }),
      fetchJson,
    });
    const ops = await collect(ctx);

    const prices = ops.filter((op) => op.kind === "asset_price");

    // ETH fungible: 1 implementation × 3 points = 3 ops
    // USDC fungible: 2 implementations × 3 points = 6 ops
    // Total: 9 asset_price ops (NOT 18 — dedup across the 2 wallets)
    expect(prices).toHaveLength(9);

    // Confirm exactly 2 fungible-chart HTTP calls (one per unique fungible id)
    const fungibleCalls = calls.filter((c) =>
      String(c.url).includes("/fungibles/"));
    expect(fungibleCalls).toHaveLength(2);
  });

  test("phase 3 uses ctx.cache: cache hit on second run skips HTTP", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = { data: { attributes: { points: [] } } };
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/"))                   return positions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return walletChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  return fungibleEth;
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const cache = new InMemoryParserCache();
    await collect(makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson, cache,
    }));
    const callsAfterRun1 = calls.length;
    await collect(makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson, cache,
    }));
    // Run 2: only the positions fetch repeats; both fungible fetches are cached
    expect(calls.length - callsAfterRun1).toBe(1);
  });

  test("phase 3 fetch failure → fungible_fetch_failed warning, other fungibles still process", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = { data: { attributes: { points: [] } } };
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const { fetchJson } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/"))                   return positions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return walletChart;
      if (url.includes("/fungibles/f-eth/charts/year"))  throw new Error("504 Gateway Timeout");
      if (url.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc;
      throw new Error(`unexpected url: ${url}`);
    });

    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson,
    });
    const ops = await collect(ctx);

    const warnings = ops.filter((op) => op.kind === "sync_warning");
    const prices = ops.filter((op) => op.kind === "asset_price");
    const fungWarn = warnings.find((w) =>
      (w as { warning: { scope: string | null } }).warning.scope === "fungible_fetch_failed");
    expect(fungWarn).toBeDefined();
    expect((fungWarn as { warning: { detail: unknown } }).warning.detail).toEqual({ fungibleId: "f-eth" });
    // USDC still produced 2 × 3 = 6 price ops
    expect(prices).toHaveLength(6);
  });

  test("fungible with empty implementations → no_implementations warning, no price ops", async () => {
    // Wire a wallet that holds the orphan fungible
    const orphanPositions = {
      data: [{
        id: "p-orphan",
        type: "positions",
        attributes: {
          quantity: { float: 100 },
          value: 500,
          fungible_info: { symbol: "ORPHAN", implementations: [{ chain_id: "ethereum", address: "0xorphan" }] },
        },
        relationships: {
          chain:    { data: { id: "ethereum" } },
          fungible: { data: { id: "f-orphan" } },
        },
      }],
      links: { next: null },
    };
    const walletChart = { data: { attributes: { points: [] } } };
    const fungibleOrphan = await loadFixture("fungible-no-impls.json");

    const { fetchJson } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("/positions/"))                       return orphanPositions;
      if (url.includes("/charts/year") && url.includes("/wallets/")) return walletChart;
      if (url.includes("/fungibles/f-orphan/charts/year"))   return fungibleOrphan;
      throw new Error(`unexpected url: ${url}`);
    });

    const ctx = makeCtx({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      fetchJson,
    });
    const ops = await collect(ctx);

    const noImplWarn = ops.find((op) =>
      op.kind === "sync_warning" &&
      (op as { warning: { scope: string | null } }).warning.scope === "no_implementations");
    expect(noImplWarn).toBeDefined();
    const prices = ops.filter((op) => op.kind === "asset_price");
    expect(prices).toHaveLength(0);
  });
});
