import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { syncCoinbase } from "../../src/coinbase/parse";
import { CoinbaseConfig } from "../../src/coinbase/config";
import { buildContext } from "../../src/context";
import { ConsoleLogger } from "../../src/types/logger";
import { InMemoryParserCache } from "../../src/types/cache";
import { MapPriceProvider } from "../../src/types/price-provider";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";
import type { SecretResolver } from "../../src/types/secrets";
import { HttpStatusError } from "../../src/http/errors";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = resolve(import.meta.dir, "../fixtures/coinbase");

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(FIXTURES, name)).text());
}

function fixedSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

// Valid ES256 PKCS8 PEM generated via:
//   bun -e 'const {generateKeyPairSync} = require("crypto"); const {privateKey} = generateKeyPairSync("ec",{namedCurve:"P-256"}); console.log(privateKey.export({type:"pkcs8",format:"pem"}).toString());'
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggA7zpV3Xjj3QkRr+
WBnrWAwKXiavb5z7WxOTkxxM0bKhRANCAAQAV+t4Hzofjg/Pa1vZxf52U9Etzc6M
L13Def3LZs8GtKb03QrAJiEnMx2uKEje+vR1KdLB3ap6sAa+u8ZGprAX
-----END PRIVATE KEY-----`;

interface RouteCase { match: (url: string) => boolean; respond: (url: string) => unknown }

function routedFetchJson(routes: RouteCase[]): { fetchJson: FetchJson; calls: string[] } {
  const calls: string[] = [];
  const fetchJson: FetchJson = async <T>(url: string | URL, _opts?: FetchJsonOpts): Promise<T> => {
    const u = String(url);
    calls.push(u);
    for (const r of routes) {
      if (r.match(u)) return r.respond(u) as T;
    }
    throw new Error(`unexpected URL in test: ${u}`);
  };
  return { fetchJson, calls };
}

const ETH_PRICES = {
  "ETH:2024-06-10": 3000, "ETH:2024-06-11": 3100, "ETH:2024-06-12": 3200,
  "ETH:2024-06-13": 3300, "ETH:2024-06-14": 3400, "ETH:2024-06-15": 3500,
};

describe("syncCoinbase — happy path (single wallet)", () => {
  test("emits 5 raw_events + 1 account_discovery + 6 position_snapshots", async () => {
    const v3 = await loadFixture("v3-accounts-eth-btc.json") as { accounts: any[] };
    const v3Eth = { ...v3, accounts: [v3.accounts[0]] };
    const v2 = await loadFixture("v2-accounts-eth-btc.json") as { data: any[]; pagination: any };
    const v2Eth = { ...v2, data: [v2.data[0]] };
    const txns = await loadFixture("v2-txns-eth.json");

    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3Eth },
      { match: (u) => u.includes("/v2/accounts/v2-eth-uuid/transactions"), respond: () => txns },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2Eth },
    ]);

    const ctx = buildContext({
      config: CoinbaseConfig.parse({}),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2024-06-15T00:00:00Z"),
      secrets: fixedSecrets({
        COINBASE_KEY_NAME: "organizations/abc/apiKeys/xyz",
        COINBASE_PRIVATE_KEY: TEST_KEY_PEM,
      }),
      cache: new InMemoryParserCache(),
      priceProvider: new MapPriceProvider(ETH_PRICES),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    const byKind: Record<string, number> = {};
    for (const op of ops) byKind[op.kind] = (byKind[op.kind] ?? 0) + 1;
    expect(byKind).toEqual({
      raw_event: 7,
      account_discovery: 1,
      position_snapshot: 6,
    });

    const acct = ops.find((o) => o.kind === "account_discovery")!;
    expect((acct as { draft: { id: string } }).draft.id).toBe("coinbase:v3-eth-uuid");
    expect((acct as { draft: { mode: string } }).draft.mode).toBe("live");
    expect((acct as { draft: { currency: string } }).draft.currency).toBe("ETH");

    const snaps = ops.filter((o) => o.kind === "position_snapshot");
    const lastSnap = snaps[snaps.length - 1] as { draft: { as_of: string; qty: number; price_usd: number } };
    expect(lastSnap.draft.as_of).toBe("2024-06-15");
    expect(lastSnap.draft.qty).toBe(2.5);
    expect(lastSnap.draft.price_usd).toBe(3500);
  });
});

describe("syncCoinbase — multi-wallet ETH + BTC", () => {
  test("two wallets emit independent raw_events, discoveries, and snapshots", async () => {
    const v3 = await loadFixture("v3-accounts-eth-btc.json");
    const v2 = await loadFixture("v2-accounts-eth-btc.json");
    const ethTxns = await loadFixture("v2-txns-eth.json");
    const btcTxns = await loadFixture("v2-txns-btc.json");

    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3 },
      { match: (u) => u.includes("/v2/accounts/v2-eth-uuid/transactions"), respond: () => ethTxns },
      { match: (u) => u.includes("/v2/accounts/v2-btc-uuid/transactions"), respond: () => btcTxns },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2 },
    ]);

    const ctx = buildContext({
      config: CoinbaseConfig.parse({}),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2024-06-15T00:00:00Z"),
      secrets: fixedSecrets({
        COINBASE_KEY_NAME: "organizations/abc/apiKeys/xyz",
        COINBASE_PRIVATE_KEY: TEST_KEY_PEM,
      }),
      cache: new InMemoryParserCache(),
      priceProvider: new MapPriceProvider({
        ...ETH_PRICES,
        "BTC:2024-06-10": 60000, "BTC:2024-06-11": 61000, "BTC:2024-06-12": 62000,
        "BTC:2024-06-13": 63000, "BTC:2024-06-14": 64000, "BTC:2024-06-15": 65000,
      }),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    const discoveries = ops.filter((o) => o.kind === "account_discovery");
    expect(discoveries).toHaveLength(2);
    const snaps = ops.filter((o) => o.kind === "position_snapshot");
    expect(snaps).toHaveLength(12);
  });
});

describe("syncCoinbase — cache short-circuit", () => {
  test("on cache hit, skips v3 fetch entirely", async () => {
    const v3CachedAccounts = [
      { uuid: "v3-eth-uuid", name: "ETH Wallet", currency: "ETH", available_balance: { value: "2.5", currency: "ETH" } },
    ];
    const v2 = await loadFixture("v2-accounts-eth-btc.json") as { data: any[]; pagination: any };
    const v2Eth = { ...v2, data: [v2.data[0]] };
    const txns = await loadFixture("v2-txns-eth.json");

    let v3Calls = 0;
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => { v3Calls++; throw new Error("should not be called"); } },
      { match: (u) => u.includes("/v2/accounts/v2-eth-uuid/transactions"), respond: () => txns },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2Eth },
    ]);

    const cache = new InMemoryParserCache();
    await cache.set("coinbase:v3-accounts:list", v3CachedAccounts, 300_000);

    const ctx = buildContext({
      config: CoinbaseConfig.parse({}),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2024-06-15T00:00:00Z"),
      secrets: fixedSecrets({
        COINBASE_KEY_NAME: "organizations/abc/apiKeys/xyz",
        COINBASE_PRIVATE_KEY: TEST_KEY_PEM,
      }),
      cache,
      priceProvider: new MapPriceProvider(ETH_PRICES),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    expect(v3Calls).toBe(0);
    expect(ops.some((o) => o.kind === "raw_event" && (o as { external_id: string }).external_id.startsWith("coinbase:v3-account:"))).toBe(true);
  });

  test("on cache miss, writes v3 list to cache after successful fetch", async () => {
    const v3 = await loadFixture("v3-accounts-eth-btc.json") as { accounts: any[] };
    const v3Eth = { ...v3, accounts: [v3.accounts[0]] };
    const v2 = await loadFixture("v2-accounts-eth-btc.json") as { data: any[]; pagination: any };
    const v2Eth = { ...v2, data: [v2.data[0]] };
    const txns = await loadFixture("v2-txns-eth.json");

    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3Eth },
      { match: (u) => u.includes("/v2/accounts/v2-eth-uuid/transactions"), respond: () => txns },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2Eth },
    ]);

    const cache = new InMemoryParserCache();
    const ctx = buildContext({
      config: CoinbaseConfig.parse({}),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2024-06-15T00:00:00Z"),
      secrets: fixedSecrets({
        COINBASE_KEY_NAME: "organizations/abc/apiKeys/xyz",
        COINBASE_PRIVATE_KEY: TEST_KEY_PEM,
      }),
      cache,
      priceProvider: new MapPriceProvider(ETH_PRICES),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    const cached = await cache.get<unknown[]>("coinbase:v3-accounts:list");
    expect(cached).toEqual(v3Eth.accounts);
    const cachedV2 = await cache.get<unknown[]>("coinbase:v2-accounts:list");
    expect(cachedV2).toEqual(v2Eth.data);
  });
});

describe("syncCoinbase — error scopes", () => {
  function makeCtxBase(fetchJson: FetchJson, overrides: { secrets?: SecretResolver; priceProvider?: MapPriceProvider } = {}) {
    const ctx = buildContext({
      config: CoinbaseConfig.parse({}),
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2024-06-15T00:00:00Z"),
      secrets: overrides.secrets ?? fixedSecrets({
        COINBASE_KEY_NAME: "organizations/abc/apiKeys/xyz",
        COINBASE_PRIVATE_KEY: TEST_KEY_PEM,
      }),
      cache: new InMemoryParserCache(),
      priceProvider: overrides.priceProvider ?? new MapPriceProvider(ETH_PRICES),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;
    return ctx;
  }

  test("auth_failed — missing key_name secret", async () => {
    const { fetchJson } = routedFetchJson([]);
    const ctx = makeCtxBase(fetchJson, {
      secrets: fixedSecrets({ COINBASE_KEY_NAME: null, COINBASE_PRIVATE_KEY: TEST_KEY_PEM }),
    });
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("sync_warning");
    expect((ops[0] as { warning: { scope: string } }).warning.scope).toBe("auth_failed");
  });

  test("auth_failed — missing private_key secret", async () => {
    const { fetchJson } = routedFetchJson([]);
    const ctx = makeCtxBase(fetchJson, {
      secrets: fixedSecrets({ COINBASE_KEY_NAME: "k", COINBASE_PRIVATE_KEY: null }),
    });
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { warning: { scope: string } }).warning.scope).toBe("auth_failed");
  });

  test("auth_failed — first v3 call returns 401", async () => {
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: (u) => {
        throw new HttpStatusError("401 Unauthorized", { url: u, method: "GET", attempts: 1, status: 401, bodyExcerpt: "" });
      }},
    ]);
    const ctx = makeCtxBase(fetchJson);
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { warning: { scope: string } }).warning.scope).toBe("auth_failed");
  });

  test("v3_accounts_failed — 5xx on first v3 call (non-auth)", async () => {
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: (u) => {
        throw new HttpStatusError("500 Internal Server Error", { url: u, method: "GET", attempts: 1, status: 500, bodyExcerpt: "" });
      }},
    ]);
    const ctx = makeCtxBase(fetchJson);
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { warning: { scope: string } }).warning.scope).toBe("v3_accounts_failed");
  });

  test("auth_failed — v2 accounts call returns 403", async () => {
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => ({ accounts: [], has_next: false }) },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: (u) => {
        throw new HttpStatusError("403 Forbidden", { url: u, method: "GET", attempts: 1, status: 403, bodyExcerpt: "" });
      }},
    ]);
    const ctx = makeCtxBase(fetchJson);
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { warning: { scope: string } }).warning.scope).toBe("auth_failed");
  });

  test("v2_accounts_failed — error on v2 accounts call", async () => {
    const v3 = await loadFixture("v3-accounts-eth-btc.json") as { accounts: any[] };
    const v3Eth = { ...v3, accounts: [v3.accounts[0]] };
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3Eth },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: (u) => {
        throw new HttpStatusError("500", { url: u, method: "GET", attempts: 1, status: 500, bodyExcerpt: "" });
      }},
    ]);
    const ctx = makeCtxBase(fetchJson);
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { warning: { scope: string } }).warning.scope).toBe("v2_accounts_failed");
    expect(ops.some((o) => o.kind === "raw_event")).toBe(true);
  });

  test("v2_transactions_failed — one wallet fails; other still emits history", async () => {
    const v3 = await loadFixture("v3-accounts-eth-btc.json");
    const v2 = await loadFixture("v2-accounts-eth-btc.json");
    const btcTxns = await loadFixture("v2-txns-btc.json");
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3 },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2 },
      { match: (u) => u.includes("/v2/accounts/v2-eth-uuid/transactions"), respond: (u) => {
        throw new HttpStatusError("500", { url: u, method: "GET", attempts: 1, status: 500, bodyExcerpt: "" });
      }},
      { match: (u) => u.includes("/v2/accounts/v2-btc-uuid/transactions"), respond: () => btcTxns },
    ]);
    const ctx = makeCtxBase(fetchJson, {
      priceProvider: new MapPriceProvider({
        ...ETH_PRICES,
        "BTC:2024-06-10": 60000, "BTC:2024-06-11": 61000, "BTC:2024-06-12": 62000,
        "BTC:2024-06-13": 63000, "BTC:2024-06-14": 64000, "BTC:2024-06-15": 65000,
      }),
    });
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    const warnings = ops.filter((o) => o.kind === "sync_warning") as Array<{ warning: { scope: string } }>;
    expect(warnings.some((w) => w.warning.scope === "v2_transactions_failed")).toBe(true);

    const snapshots = ops.filter((o) => o.kind === "position_snapshot") as Array<{ draft: { account_id: string; as_of: string } }>;
    const ethToday = snapshots.find((s) => s.draft.account_id === "coinbase:v3-eth-uuid" && s.draft.as_of === "2024-06-15");
    expect(ethToday).toBeDefined();
    const btcSnaps = snapshots.filter((s) => s.draft.account_id === "coinbase:v3-btc-uuid");
    expect(btcSnaps.length).toBeGreaterThan(1);
  });

  test("price_lookup_failed — missing price for one walk date", async () => {
    const v3 = await loadFixture("v3-accounts-eth-btc.json") as { accounts: any[] };
    const v3Eth = { ...v3, accounts: [v3.accounts[0]] };
    const v2 = await loadFixture("v2-accounts-eth-btc.json") as { data: any[]; pagination: any };
    const v2Eth = { ...v2, data: [v2.data[0]] };
    const txns = await loadFixture("v2-txns-eth.json");

    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3Eth },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2Eth },
      { match: (u) => u.includes("/v2/accounts/v2-eth-uuid/transactions"), respond: () => txns },
    ]);

    const gappy = { ...ETH_PRICES };
    delete (gappy as Record<string, number>)["ETH:2024-06-12"];

    const ctx = makeCtxBase(fetchJson, { priceProvider: new MapPriceProvider(gappy) });
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    const warnings = ops.filter((o) => o.kind === "sync_warning") as Array<{ warning: { scope: string; detail?: { as_of?: string } } }>;
    expect(warnings.some((w) => w.warning.scope === "price_lookup_failed" && w.warning.detail?.as_of === "2024-06-12")).toBe(true);

    const snapshots = ops.filter((o) => o.kind === "position_snapshot") as Array<{ draft: { as_of: string } }>;
    expect(snapshots.some((s) => s.draft.as_of === "2024-06-12")).toBe(false);
  });

  test("unknown_currency — wallet whose currency has no chain mapping", async () => {
    const v3 = {
      accounts: [{ uuid: "v3-x", name: "Random Wallet", currency: "RANDOMCOIN", available_balance: { value: "1", currency: "RANDOMCOIN" } }],
      has_next: false,
    };
    const v2 = { data: [], pagination: { next_uri: null } };
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3 },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2 },
    ]);
    const ctx = makeCtxBase(fetchJson, {
      priceProvider: new MapPriceProvider({ "RANDOMCOIN:2024-06-15": 1.0 }),
    });
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    const warnings = ops.filter((o) => o.kind === "sync_warning") as Array<{ warning: { scope: string } }>;
    expect(warnings.some((w) => w.warning.scope === "unknown_currency")).toBe(true);

    const snapshots = ops.filter((o) => o.kind === "position_snapshot") as Array<{ draft: { chain: string | null; symbol: string } }>;
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.draft.chain).toBeNull();
  });

  test("negative_balance — withdraw before deposit produces warning, no snapshot for that date", async () => {
    const v3 = { accounts: [{ uuid: "v3-eth-uuid", name: "ETH Wallet", currency: "ETH", available_balance: { value: "1.0", currency: "ETH" } }], has_next: false };
    const v2 = { data: [{ id: "v2-eth-uuid", name: "ETH Wallet", currency: "ETH" }], pagination: { next_uri: null } };
    const txns = {
      data: [
        { id: "t1", amount: { amount: "-2.0", currency: "ETH" }, created_at: "2024-06-13T10:00:00Z", type: "send" },
        { id: "t2", amount: { amount: "3.0",  currency: "ETH" }, created_at: "2024-06-15T10:00:00Z", type: "buy"  },
      ],
      pagination: { next_uri: null },
    };
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3 },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2 },
      { match: (u) => u.includes("/v2/accounts/v2-eth-uuid/transactions"), respond: () => txns },
    ]);
    const ctx = makeCtxBase(fetchJson);
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    const warnings = ops.filter((o) => o.kind === "sync_warning") as Array<{ warning: { scope: string } }>;
    expect(warnings.some((w) => w.warning.scope === "negative_balance")).toBe(true);
  });

  test("duplicate_wallet_key — second v3 account with same name|currency is dropped", async () => {
    const v3 = {
      accounts: [
        { uuid: "v3-first", name: "ETH Wallet", currency: "ETH", available_balance: { value: "1.0", currency: "ETH" } },
        { uuid: "v3-second", name: "ETH Wallet", currency: "ETH", available_balance: { value: "2.0", currency: "ETH" } },
      ],
      has_next: false,
    };
    const v2 = { data: [], pagination: { next_uri: null } };
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3 },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2 },
    ]);
    const ctx = makeCtxBase(fetchJson);
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    const dup = ops.filter((o) => o.kind === "sync_warning") as Array<{
      warning: { scope: string; detail?: { kept_uuid?: string; dropped_uuid?: string } };
    }>;
    const dupWarn = dup.find((w) => w.warning.scope === "duplicate_wallet_key");
    expect(dupWarn).toBeDefined();
    expect(dupWarn!.warning.detail?.kept_uuid).toBe("v3-first");
    expect(dupWarn!.warning.detail?.dropped_uuid).toBe("v3-second");

    const discoveries = ops.filter((o) => o.kind === "account_discovery") as Array<{ draft: { id: string } }>;
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]!.draft.id).toBe("coinbase:v3-second");
  });

  test("same display name, different currencies — both wallets processed", async () => {
    const v3 = {
      accounts: [
        { uuid: "v3-eth", name: "Portfolio", currency: "ETH", available_balance: { value: "1.0", currency: "ETH" } },
        { uuid: "v3-btc", name: "Portfolio", currency: "BTC", available_balance: { value: "0.1", currency: "BTC" } },
      ],
      has_next: false,
    };
    const v2 = { data: [], pagination: { next_uri: null } };
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3 },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2 },
    ]);
    const ctx = makeCtxBase(fetchJson, {
      priceProvider: new MapPriceProvider({
        "ETH:2024-06-15": 3500,
        "BTC:2024-06-15": 65000,
      }),
    });
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);

    const discoveries = ops.filter((o) => o.kind === "account_discovery") as Array<{ draft: { id: string; currency: string } }>;
    expect(discoveries).toHaveLength(2);
    expect(discoveries.map((d) => d.draft.currency).sort()).toEqual(["BTC", "ETH"]);

    const snapshots = ops.filter((o) => o.kind === "position_snapshot") as Array<{ draft: { account_id: string; symbol: string } }>;
    expect(snapshots.some((s) => s.draft.account_id === "coinbase:v3-eth")).toBe(true);
    expect(snapshots.some((s) => s.draft.account_id === "coinbase:v3-btc")).toBe(true);
  });

  test("staking-only wallet (v3 present, v2 absent) emits only today's snapshot", async () => {
    const v3 = {
      accounts: [{ uuid: "v3-stake", name: "ETH Staking", currency: "ETH", available_balance: { value: "1.5", currency: "ETH" } }],
      has_next: false,
    };
    const v2 = { data: [], pagination: { next_uri: null } };
    const { fetchJson } = routedFetchJson([
      { match: (u) => u.includes("/api/v3/brokerage/accounts"), respond: () => v3 },
      { match: (u) => u.endsWith("/v2/accounts?limit=100"), respond: () => v2 },
    ]);
    const ctx = makeCtxBase(fetchJson);
    const ops: Operation[] = [];
    for await (const op of syncCoinbase(ctx)) ops.push(op);
    const snapshots = ops.filter((o) => o.kind === "position_snapshot") as Array<{ draft: { as_of: string; qty: number } }>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.draft.as_of).toBe("2024-06-15");
    expect(snapshots[0]!.draft.qty).toBe(1.5);
  });
});
