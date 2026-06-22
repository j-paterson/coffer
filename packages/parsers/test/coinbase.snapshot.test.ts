import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { coinbaseParser } from "../src/coinbase";
import { CoinbaseConfig } from "../src/coinbase/config";
import { buildContext } from "../src/context";
import { ConsoleLogger } from "../src/types/logger";
import { InMemoryParserCache } from "../src/types/cache";
import { MapPriceProvider } from "../src/types/price-provider";
import type { FetchJson, FetchJsonOpts } from "../src/types/http";
import type { SecretResolver } from "../src/types/secrets";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = resolve(import.meta.dir, "fixtures/coinbase");

const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgqMf9T1L7C2n0rx4U
5mT2y1Is0X08aRV7hrEIn8D0SYOhRANCAAQEP8CE+LmnA2OnMqNMHxyLxuzJ03xr
UFxUoOfCxtMe4OTxDKjl6DMWro3W0qeL4H5dH20hJSOJ5U63/fCeHL9G
-----END PRIVATE KEY-----`;

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

describe("coinbaseParser surface", () => {
  test("exports id, name, capabilities, configSchema, sync", () => {
    expect(coinbaseParser.id).toBe("coinbase");
    expect(coinbaseParser.name).toBe("Coinbase");
    expect(coinbaseParser.capabilities).toEqual(["accounts", "positions"]);
    expect(coinbaseParser.configSchema).toBe(CoinbaseConfig);
    expect(typeof coinbaseParser.sync).toBe("function");
  });

  test("end-to-end Operation stream is stable (snapshot)", async () => {
    const v3 = await loadFixture("v3-accounts-eth-btc.json");
    const v2 = await loadFixture("v2-accounts-eth-btc.json");
    const ethTxns = await loadFixture("v2-txns-eth.json");
    const btcTxns = await loadFixture("v2-txns-btc.json");

    const fetchJson: FetchJson = async <T>(url: string | URL, _opts?: FetchJsonOpts): Promise<T> => {
      const u = String(url);
      if (u.includes("/api/v3/brokerage/accounts")) return v3 as T;
      if (u.endsWith("/v2/accounts?limit=100")) return v2 as T;
      if (u.includes("/v2/accounts/v2-eth-uuid/transactions")) return ethTxns as T;
      if (u.includes("/v2/accounts/v2-btc-uuid/transactions")) return btcTxns as T;
      throw new Error(`unexpected URL: ${u}`);
    };

    const prices = new MapPriceProvider({
      "ETH:2024-06-10": 3000, "ETH:2024-06-11": 3100, "ETH:2024-06-12": 3200,
      "ETH:2024-06-13": 3300, "ETH:2024-06-14": 3400, "ETH:2024-06-15": 3500,
      "BTC:2024-06-10": 60000, "BTC:2024-06-11": 61000, "BTC:2024-06-12": 62000,
      "BTC:2024-06-13": 63000, "BTC:2024-06-14": 64000, "BTC:2024-06-15": 65000,
    });

    const ctx = buildContext({
      config: CoinbaseConfig.parse({}),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2024-06-15T00:00:00Z"),
      secrets: fixedSecrets({
        COINBASE_KEY_NAME: "organizations/abc/apiKeys/xyz",
        COINBASE_PRIVATE_KEY: TEST_KEY_PEM,
      }),
      cache: new InMemoryParserCache(),
      priceProvider: prices,
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of coinbaseParser.sync(ctx)) ops.push(op);

    expect(ops).toMatchSnapshot();
  });
});
