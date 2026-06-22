import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { zerionParser } from "../src/zerion";
import { ZerionConfig } from "../src/zerion/config";
import { buildContext } from "../src/context";
import { ConsoleLogger } from "../src/types/logger";
import { InMemoryParserCache } from "../src/types/cache";
import type { FetchJson, FetchJsonOpts } from "../src/types/http";
import type { SecretResolver } from "../src/types/secrets";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = resolve(import.meta.dir, "fixtures/zerion");
const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

describe("zerionParser surface", () => {
  test("exports id, name, capabilities, configSchema, sync", () => {
    expect(zerionParser.id).toBe("zerion");
    expect(zerionParser.name).toBe("Zerion");
    expect(zerionParser.capabilities).toEqual(["accounts", "positions", "balances", "prices"]);
    expect(zerionParser.configSchema).toBe(ZerionConfig);
    expect(typeof zerionParser.sync).toBe("function");
  });

  test("end-to-end Operation stream is stable (snapshot)", async () => {
    const positions = await loadFixture("positions-eth-base.json");
    const walletChart = await loadFixture("wallet-chart-year.json");
    const fungibleEth = await loadFixture("fungible-chart-eth.json");
    const fungibleUsdc = await loadFixture("fungible-chart-usdc.json");

    const fetchJson: FetchJson = async <T>(url: string | URL, _opts?: FetchJsonOpts): Promise<T> => {
      const u = String(url);
      if (u.includes("/positions/"))                   return positions as T;
      if (u.includes("/charts/year") && u.includes("/wallets/")) return walletChart as T;
      if (u.includes("/fungibles/f-eth/charts/year"))  return fungibleEth as T;
      if (u.includes("/fungibles/f-usdc/charts/year")) return fungibleUsdc as T;
      throw new Error(`unexpected url: ${u}`);
    };

    const ctx = buildContext({
      config: ZerionConfig.parse({ wallets: [ADDR] }),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2023-11-25T00:00:00Z"),
      secrets: fixedSecrets({ ZERION_API_KEY: "test-key" }),
      cache: new InMemoryParserCache(),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of zerionParser.sync(ctx)) ops.push(op);

    expect(ops).toMatchSnapshot();
  });
});
