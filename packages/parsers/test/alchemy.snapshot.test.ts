import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { alchemyParser } from "../src/alchemy";
import { AlchemyConfig } from "../src/alchemy/config";
import { buildContext } from "../src/context";
import { ConsoleLogger } from "../src/types/logger";
import { InMemoryParserCache } from "../src/types/cache";
import type { FetchJson, FetchJsonOpts } from "../src/types/http";
import type { SecretResolver } from "../src/types/secrets";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = resolve(import.meta.dir, "fixtures/alchemy");
const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

interface JsonRpcBody { jsonrpc: "2.0"; id: string; method: string; params: unknown }

describe("alchemyParser surface", () => {
  test("exports id, name, capabilities, configSchema, sync", () => {
    expect(alchemyParser.id).toBe("alchemy");
    expect(alchemyParser.name).toBe("Alchemy");
    expect(alchemyParser.capabilities).toEqual(["accounts", "positions"]);
    expect(alchemyParser.configSchema).toBe(AlchemyConfig);
    expect(typeof alchemyParser.sync).toBe("function");
  });

  test("end-to-end Operation stream is stable (snapshot)", async () => {
    const nativeEth      = await loadFixture("native-balance-eth.json");
    const ethBalances    = await loadFixture("token-balances-eth-usdc-weth.json");
    const baseBalances   = await loadFixture("token-balances-base-usdc.json");
    const usdcMeta       = await loadFixture("metadata-usdc.json");
    const wethMeta       = await loadFixture("metadata-weth.json");
    const baseUsdcMeta   = { name: "USD Coin", symbol: "USDC", decimals: 6, logo: null };

    const fetchJson: FetchJson = async <T>(url: string | URL, opts?: FetchJsonOpts): Promise<T> => {
      const u = String(url);
      const body = opts!.body as JsonRpcBody;
      const id = body.id;
      const chainSlug = u.match(/https:\/\/([a-z-]+)\.g\.alchemy\.com/)?.[1];

      if (body.method === "eth_getBalance") {
        return { jsonrpc: "2.0", id, result: nativeEth } as T;
      }
      if (body.method === "alchemy_getTokenBalances") {
        if (chainSlug === "eth-mainnet")  return { jsonrpc: "2.0", id, result: ethBalances } as T;
        if (chainSlug === "base-mainnet") return { jsonrpc: "2.0", id, result: baseBalances } as T;
        throw new Error(`unexpected chain slug: ${chainSlug}`);
      }
      if (body.method === "alchemy_getTokenMetadata") {
        const [contract] = body.params as [string];
        if (contract === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return { jsonrpc: "2.0", id, result: usdcMeta } as T;
        if (contract === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return { jsonrpc: "2.0", id, result: wethMeta } as T;
        if (contract === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") return { jsonrpc: "2.0", id, result: baseUsdcMeta } as T;
        throw new Error(`unexpected contract: ${contract}`);
      }
      throw new Error(`unexpected method: ${body.method}`);
    };

    const ctx = buildContext({
      config: AlchemyConfig.parse({ wallets: [ADDR], chains: ["ethereum", "base"] }),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2026-05-14T00:00:00Z"),
      secrets: fixedSecrets({ ALCHEMY_API_KEY: "test-key" }),
      cache: new InMemoryParserCache(),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of alchemyParser.sync(ctx)) ops.push(op);

    expect(ops).toMatchSnapshot();
  });
});
