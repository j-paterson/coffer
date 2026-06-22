import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { syncAlchemy } from "../../src/alchemy/parse";
import { AlchemyConfig } from "../../src/alchemy/config";
import { buildContext } from "../../src/context";
import { ConsoleLogger } from "../../src/types/logger";
import { InMemoryParserCache } from "../../src/types/cache";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";
import type { SecretResolver } from "../../src/types/secrets";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = resolve(import.meta.dir, "../fixtures/alchemy");
const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";

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

interface JsonRpcBody { jsonrpc: "2.0"; id: string; method: string; params: unknown }

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

async function collectOps(gen: AsyncIterable<Operation>): Promise<Operation[]> {
  const out: Operation[] = [];
  for await (const op of gen) out.push(op);
  return out;
}

function makeCtx(opts: {
  config: ReturnType<typeof AlchemyConfig.parse>;
  fetchJson: FetchJson;
  secrets?: SecretResolver;
  cache?: InMemoryParserCache;
}) {
  const ctx = buildContext({
    config: opts.config,
    logger: new ConsoleLogger(SILENT_SINK),
    now: () => new Date("2026-05-14T00:00:00Z"),
    secrets: opts.secrets ?? fixedSecrets({ ALCHEMY_API_KEY: "test-key" }),
    cache: opts.cache ?? new InMemoryParserCache(),
  });
  (ctx as { fetchJson: FetchJson }).fetchJson = opts.fetchJson;
  return ctx;
}

describe("syncAlchemy auth gate", () => {
  test("yields a sync_warning and returns when api_key_env is unset", async () => {
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR] }),
      fetchJson,
      secrets: fixedSecrets({ ALCHEMY_API_KEY: null }),
    });
    const ops = await collectOps(syncAlchemy(ctx));
    expect(calls).toHaveLength(0);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("sync_warning");
    expect((ops[0] as { warning: { scope: string } }).warning.scope).toBe("config");
  });

  test("short-circuits with zero ops when wallets is empty", async () => {
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const ctx = makeCtx({
      config: AlchemyConfig.parse({}),
      fetchJson,
    });
    const ops = await collectOps(syncAlchemy(ctx));
    expect(calls).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });
});

describe("syncAlchemy happy path (single wallet, single chain)", () => {
  test("emits account_discovery + native + token positions for one (wallet, chain)", async () => {
    const native = await loadFixture("native-balance-eth.json");        // 1.5 ETH
    const balances = await loadFixture("token-balances-eth-usdc-weth.json");
    const usdcMeta = await loadFixture("metadata-usdc.json");
    const wethMeta = await loadFixture("metadata-weth.json");

    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balances };
      if (body.method === "alchemy_getTokenMetadata") {
        const [contract] = body.params as [string];
        if (contract === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return { jsonrpc: "2.0", id, result: usdcMeta };
        if (contract === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return { jsonrpc: "2.0", id, result: wethMeta };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
    });
    const ops = await collectOps(syncAlchemy(ctx));

    // Expected: 1 account_discovery + 1 native ETH + 2 ERC-20 = 4 ops
    expect(ops).toHaveLength(4);
    expect(ops[0]!.kind).toBe("account_discovery");
    expect((ops[0] as { draft: { id: string } }).draft.id)
      .toBe(`zerion:ethereum:${ADDR}`);
    expect(ops[1]!.kind).toBe("position_snapshot");
    expect((ops[1] as { draft: { symbol: string } }).draft.symbol).toBe("ETH");
    expect((ops[1] as { draft: { qty: number } }).draft.qty).toBeCloseTo(1.5, 12);
    expect(ops[2]!.kind).toBe("position_snapshot");
    expect((ops[2] as { draft: { symbol: string } }).draft.symbol).toBe("USDC");
    expect(ops[3]!.kind).toBe("position_snapshot");
    expect((ops[3] as { draft: { symbol: string } }).draft.symbol).toBe("WETH");
  });

  test("skips zero-balance token rows", async () => {
    const native = await loadFixture("native-balance-eth.json");
    const balances = await loadFixture("token-balances-eth-usdc-weth.json");
    const usdcMeta = await loadFixture("metadata-usdc.json");
    const wethMeta = await loadFixture("metadata-weth.json");

    const metadataCalls: string[] = [];
    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balances };
      if (body.method === "alchemy_getTokenMetadata") {
        const [contract] = body.params as [string];
        metadataCalls.push(contract);
        if (contract === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return { jsonrpc: "2.0", id, result: usdcMeta };
        if (contract === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return { jsonrpc: "2.0", id, result: wethMeta };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
    });
    await collectOps(syncAlchemy(ctx));

    expect(metadataCalls).toEqual([
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    ]);
    expect(metadataCalls).not.toContain("0xdeadbeef00000000000000000000000000000000");
  });

  test("emits zero ops for a wallet/chain with no native balance and no tokens", async () => {
    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: "0x" };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: { tokenBalances: [] } };
      throw new Error(`unexpected: ${body.method}`);
    });

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
    });
    const ops = await collectOps(syncAlchemy(ctx));
    expect(ops).toEqual([]);
  });
});

describe("syncAlchemy metadata cache", () => {
  test("ctx.cache hit short-circuits the metadata RPC", async () => {
    const native = await loadFixture("native-balance-eth.json");
    const balances = await loadFixture("token-balances-eth-usdc-weth.json");

    const metadataCalls: string[] = [];
    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balances };
      if (body.method === "alchemy_getTokenMetadata") {
        metadataCalls.push((body.params as [string])[0]);
        // If the test reaches here, the cache didn't hit.
        return { jsonrpc: "2.0", id, result: { symbol: "X", decimals: 6 } };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const cache = new InMemoryParserCache();
    await cache.set(
      "alchemy:metadata:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      { symbol: "USDC", decimals: 6 },
      86400,
    );
    await cache.set(
      "alchemy:metadata:ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      { symbol: "WETH", decimals: 18 },
      86400,
    );

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
      cache,
    });
    const ops = await collectOps(syncAlchemy(ctx));

    expect(metadataCalls).toEqual([]);   // pure cache hits
    expect(ops).toHaveLength(4);          // discovery + ETH + USDC + WETH
  });

  test("metadata RPC result is persisted to ctx.cache for next run", async () => {
    const native = await loadFixture("native-balance-eth.json");
    const balances = await loadFixture("token-balances-eth-usdc-weth.json");
    const usdcMeta = await loadFixture("metadata-usdc.json");
    const wethMeta = await loadFixture("metadata-weth.json");

    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balances };
      if (body.method === "alchemy_getTokenMetadata") {
        const [contract] = body.params as [string];
        if (contract === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return { jsonrpc: "2.0", id, result: usdcMeta };
        if (contract === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return { jsonrpc: "2.0", id, result: wethMeta };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const cache = new InMemoryParserCache();
    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
      cache,
    });
    await collectOps(syncAlchemy(ctx));

    const usdcCached = await cache.get(
      "alchemy:metadata:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
    const wethCached = await cache.get(
      "alchemy:metadata:ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    );
    expect(usdcCached).toEqual(usdcMeta as unknown as Record<string, unknown>);
    expect(wethCached).toEqual(wethMeta as unknown as Record<string, unknown>);
  });

  test("in-process Map dedups metadata fetches within a single run", async () => {
    // Two wallets both hold the same USDC contract on ethereum.
    // The 2nd wallet should NOT trigger a 2nd alchemy_getTokenMetadata
    // call, because the in-process map remembers wallet 1's lookup.
    const ADDR2 = "0x1111111111111111111111111111111111111111";

    const native = "0x14d1120d7b160000";
    const balancesForBoth = {
      tokenBalances: [
        { contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenBalance: "0x3b9aca00" },
      ],
    };
    const usdcMeta = await loadFixture("metadata-usdc.json");

    const metadataCalls: string[] = [];
    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balancesForBoth };
      if (body.method === "alchemy_getTokenMetadata") {
        metadataCalls.push((body.params as [string])[0]);
        return { jsonrpc: "2.0", id, result: usdcMeta };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const cache = new InMemoryParserCache();
    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR, ADDR2], chains: ["ethereum"] }),
      fetchJson,
      cache,
    });
    await collectOps(syncAlchemy(ctx));

    expect(metadataCalls).toEqual(["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]);
  });
});

describe("syncAlchemy error isolation", () => {
  test("native_balance_failed: token loop still runs and emits", async () => {
    const balances = await loadFixture("token-balances-eth-usdc-weth.json");
    const usdcMeta = await loadFixture("metadata-usdc.json");
    const wethMeta = await loadFixture("metadata-weth.json");

    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance") {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: "node down" } };
      }
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balances };
      if (body.method === "alchemy_getTokenMetadata") {
        const [contract] = body.params as [string];
        if (contract === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return { jsonrpc: "2.0", id, result: usdcMeta };
        if (contract === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return { jsonrpc: "2.0", id, result: wethMeta };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
    });
    const ops = await collectOps(syncAlchemy(ctx));

    // sync_warning + account_discovery + 2 token snapshots (no native)
    const warnings = ops.filter((o) => o.kind === "sync_warning");
    const positions = ops.filter((o) => o.kind === "position_snapshot");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("native_balance_failed");
    expect(positions).toHaveLength(2);
    expect((positions[0] as { draft: { symbol: string } }).draft.symbol).toBe("USDC");
  });

  test("token_balances_failed: native still emits", async () => {
    const native = await loadFixture("native-balance-eth.json");

    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances") {
        return { jsonrpc: "2.0", id, error: { code: -32603, message: "internal" } };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
    });
    const ops = await collectOps(syncAlchemy(ctx));

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    const positions = ops.filter((o) => o.kind === "position_snapshot");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("token_balances_failed");
    expect(positions).toHaveLength(1);
    expect((positions[0] as { draft: { symbol: string } }).draft.symbol).toBe("ETH");
  });

  test("token_metadata_failed: other tokens unaffected", async () => {
    const native = await loadFixture("native-balance-eth.json");
    const balances = await loadFixture("token-balances-eth-usdc-weth.json");
    const wethMeta = await loadFixture("metadata-weth.json");

    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balances };
      if (body.method === "alchemy_getTokenMetadata") {
        const [contract] = body.params as [string];
        if (contract === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "no token" } };
        }
        if (contract === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return { jsonrpc: "2.0", id, result: wethMeta };
      }
      throw new Error(`unexpected: ${body.method}`);
    });

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
    });
    const ops = await collectOps(syncAlchemy(ctx));

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    const positions = ops.filter((o) => o.kind === "position_snapshot");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("token_metadata_failed");
    // Native ETH + WETH; USDC dropped due to metadata failure.
    const symbols = positions.map((p) => (p as { draft: { symbol: string } }).draft.symbol);
    expect(symbols).toEqual(["ETH", "WETH"]);
  });

  test("buildTokenPosition returns null when metadata has no symbol — drops silently", async () => {
    const native = "0x";   // zero native so we only test token path
    const balances = {
      tokenBalances: [
        { contractAddress: "0xbad000000000000000000000000000000000000a", tokenBalance: "0x1" },
      ],
    };
    const noSym = await loadFixture("metadata-no-symbol.json");

    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      const id = body.id;
      if (body.method === "eth_getBalance")            return { jsonrpc: "2.0", id, result: native };
      if (body.method === "alchemy_getTokenBalances")  return { jsonrpc: "2.0", id, result: balances };
      if (body.method === "alchemy_getTokenMetadata")  return { jsonrpc: "2.0", id, result: noSym };
      throw new Error(`unexpected: ${body.method}`);
    });

    const ctx = makeCtx({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum"] }),
      fetchJson,
    });
    const ops = await collectOps(syncAlchemy(ctx));
    // No positions kept → no account_discovery either (matches Python).
    expect(ops).toEqual([]);
  });
});
