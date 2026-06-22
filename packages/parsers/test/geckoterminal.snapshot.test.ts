import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { geckoTerminalParser } from "../src/geckoterminal";
import { GeckoTerminalConfig } from "../src/geckoterminal/config";
import { buildContext } from "../src/context";
import { ConsoleLogger } from "../src/types/logger";
import { InMemoryParserCache } from "../src/types/cache";
import type { FetchJson, FetchJsonOpts } from "../src/types/http";
import type { SecretResolver } from "../src/types/secrets";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = resolve(import.meta.dir, "fixtures/geckoterminal");

const USDC_ETH  = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AERO_BASE = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

describe("geckoTerminalParser surface", () => {
  test("exports id, name, capabilities, configSchema, sync", () => {
    expect(geckoTerminalParser.id).toBe("geckoterminal");
    expect(geckoTerminalParser.name).toBe("GeckoTerminal");
    expect(geckoTerminalParser.capabilities).toEqual(["prices"]);
    expect(geckoTerminalParser.configSchema).toBe(GeckoTerminalConfig);
    expect(typeof geckoTerminalParser.sync).toBe("function");
  });

  test("end-to-end Operation stream is stable (snapshot)", async () => {
    const poolsSingle = await loadFixture("pools-single.json");
    const poolsAerodrome = await loadFixture("pools-aerodrome-token.json");
    const ohlcvPartial = await loadFixture("ohlcv-partial-page.json");

    const fetchJson: FetchJson = async <T>(url: string | URL, opts?: FetchJsonOpts): Promise<T> => {
      void opts;
      const s = String(url);
      if (s.includes("/networks/eth/tokens/"))   return poolsSingle as T;
      if (s.includes("/networks/base/tokens/"))  return poolsAerodrome as T;
      if (s.includes("/ohlcv/"))                 return ohlcvPartial as T;
      throw new Error(`unexpected url: ${s}`);
    };

    const cache = new InMemoryParserCache();
    const ctx = buildContext({
      config: GeckoTerminalConfig.parse({
        targets: [
          { symbol: "USDC", chain: "ethereum", contract: USDC_ETH, from: "2024-04-01" },
          { symbol: "AERO", chain: "base",     contract: AERO_BASE, from: "2024-04-01" },
        ],
        rate_per_minute: 100000,
      }),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2024-05-15T00:00:00Z"),
      secrets: fixedSecrets({}),
      cache,
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of geckoTerminalParser.sync(ctx)) ops.push(op);

    expect(ops).toMatchSnapshot();
  });
});
