import type { Operation } from "@coffer/ledger/runner";
import type { ParserContext } from "../types/parser";
import { HttpStatusError } from "../http/errors";
import { makeTokenBucket } from "../shared/rate-limit";
import { buildCoinbaseJwt } from "../shared/jwt-es256";
import {
  fetchV3Accounts,
  fetchV2Accounts,
  fetchV2Transactions,
  USER_AGENT,
  type V3Account,
  type V2Account,
  type V2Transaction,
  type BuildJwt,
} from "./client";
import {
  defaultChainFor,
  rawEventFromV3Account,
  rawEventFromV2Account,
  rawEventFromV2Txn,
  accountDiscoveryFor,
  positionSnapshotFor,
  walletJoinKey,
} from "./mapper";
import { runQuantityWalk, walkWarningMessage, type WalkWarning } from "./walk";
import { CoinbaseConfig as CoinbaseConfigSchema, DEFAULT_CHAIN_MAP } from "./config";
import type { CoinbaseConfig } from "./config";

export { CoinbaseConfigSchema };

const BASE_URL = "https://api.coinbase.com";

function syncWarning(
  scope: string,
  message: string,
  detail?: unknown,
): Extract<Operation, { kind: "sync_warning" }> {
  return {
    kind: "sync_warning",
    warning: { source: "coinbase", scope, message, detail },
  };
}

function syncWarningFromWalk(w: WalkWarning): Extract<Operation, { kind: "sync_warning" }> {
  return syncWarning(w.scope, walkWarningMessage(w), w.detail);
}

function todayIso(d: Date): string {
  const yy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function v2AccountCurrency(a: V2Account): string {
  if (typeof a.currency === "string") return a.currency;
  return a.currency.code;
}

function buildWalletMap<T>(
  items: T[],
  keyFn: (item: T) => string,
  duplicateWarning: (
    key: string,
    kept: T,
    dropped: T,
  ) => Extract<Operation, { kind: "sync_warning" }>,
): { map: Map<string, T>; warnings: Array<Extract<Operation, { kind: "sync_warning" }>> } {
  const map = new Map<string, T>();
  const warnings: Array<Extract<Operation, { kind: "sync_warning" }>> = [];
  for (const item of items) {
    const key = keyFn(item);
    const kept = map.get(key);
    if (kept !== undefined) {
      warnings.push(duplicateWarning(key, kept, item));
    }
    map.set(key, item);
  }
  return { map, warnings };
}

async function* emitTodayPositionSnapshot(params: {
  priceProvider: ParserContext<CoinbaseConfig>["priceProvider"];
  symbol: string;
  chain: string;
  asOf: string;
  qty: number;
  accountId: string;
}): AsyncGenerator<Operation> {
  const { priceProvider, symbol, chain, asOf, qty, accountId } = params;
  const px = await priceProvider.getPrice({
    symbol,
    chain,
    contract_address: "",
    as_of: asOf,
  });

  if (px == null) {
    yield syncWarning("price_lookup_failed", `No price for ${symbol} on ${asOf}`, {
      symbol,
      as_of: asOf,
    });
    return;
  }

  yield positionSnapshotFor({
    account_id: accountId,
    symbol,
    chain,
    as_of: asOf,
    qty,
    price_usd: px.price_usd,
  });
}

function isAuthError(err: unknown): err is HttpStatusError {
  return err instanceof HttpStatusError && (err.status === 401 || err.status === 403);
}

export async function* syncCoinbase(
  ctx: ParserContext<CoinbaseConfig>,
): AsyncIterable<Operation> {
  const cfg = ctx.config;
  const today = todayIso(ctx.now());

  const keyName = await ctx.secrets.get(cfg.key_name_env);
  const privateKey = await ctx.secrets.get(cfg.private_key_env);
  if (!keyName || !privateKey) {
    yield syncWarning("auth_failed", "Missing Coinbase key name or private key");
    return;
  }

  const bucket = makeTokenBucket({ ratePerMinute: cfg.rate_per_minute });
  const buildJwt: BuildJwt = async ({ method, host, path }) => {
    await bucket.acquire();
    return buildCoinbaseJwt({ keyName, privateKeyPem: privateKey, method, host, path });
  };

  // --- V3 accounts ---
  const v3CacheKey = "coinbase:v3-accounts:list";
  let v3List: V3Account[];
  const v3Cached = await ctx.cache.get<V3Account[]>(v3CacheKey);
  if (v3Cached) {
    v3List = v3Cached;
  } else {
    try {
      v3List = await fetchV3Accounts({ fetchJson: ctx.fetchJson, baseUrl: BASE_URL, buildJwt, userAgent: USER_AGENT });
    } catch (err) {
      if (isAuthError(err)) {
        yield syncWarning("auth_failed", "Coinbase rejected JWT", { status: err.status });
      } else {
        yield syncWarning("v3_accounts_failed", "Failed to fetch v3 accounts", { error: String(err) });
      }
      return;
    }
    await ctx.cache.set(v3CacheKey, v3List, cfg.accounts_cache_ttl_seconds);
  }

  for (const a of v3List) {
    yield rawEventFromV3Account(a, today);
  }
  const { map: v3Map, warnings: v3DupWarnings } = buildWalletMap(
    v3List,
    (a) => walletJoinKey(a.name, a.currency),
    (key, kept, dropped) =>
      syncWarning("duplicate_wallet_key", `Duplicate v3 wallet key: ${key}`, {
        key,
        kept_uuid: (kept as V3Account).uuid,
        dropped_uuid: (dropped as V3Account).uuid,
      }),
  );
  for (const w of v3DupWarnings) yield w;

  // --- V2 accounts ---
  const v2CacheKey = "coinbase:v2-accounts:list";
  let v2List: V2Account[];
  const v2Cached = await ctx.cache.get<V2Account[]>(v2CacheKey);
  if (v2Cached) {
    v2List = v2Cached;
  } else {
    try {
      v2List = await fetchV2Accounts({ fetchJson: ctx.fetchJson, baseUrl: BASE_URL, buildJwt, userAgent: USER_AGENT });
    } catch (err) {
      if (isAuthError(err)) {
        yield syncWarning("auth_failed", "Coinbase rejected JWT", { status: err.status });
      } else {
        yield syncWarning("v2_accounts_failed", "Failed to fetch v2 accounts", { error: String(err) });
      }
      return;
    }
    await ctx.cache.set(v2CacheKey, v2List, cfg.accounts_cache_ttl_seconds);
  }

  for (const a of v2List) {
    yield rawEventFromV2Account(a, today);
  }
  const { map: v2Map, warnings: v2DupWarnings } = buildWalletMap(
    v2List,
    (a) => walletJoinKey(a.name, v2AccountCurrency(a)),
    (key, kept, dropped) =>
      syncWarning("duplicate_wallet_key", `Duplicate v2 wallet key: ${key}`, {
        key,
        kept_id: (kept as V2Account).id,
        dropped_id: (dropped as V2Account).id,
      }),
  );
  for (const w of v2DupWarnings) yield w;

  // --- Per-wallet processing ---
  const allWalletKeys = new Set<string>([...v3Map.keys(), ...v2Map.keys()]);
  const seenUnknownCurrencies = new Set<string>();

  for (const walletKey of allWalletKeys) {
    const v3 = v3Map.get(walletKey);
    const v2 = v2Map.get(walletKey);

    const display = v3?.name ?? v2?.name ?? walletKey;
    const currency = v3?.currency ?? (v2 ? v2AccountCurrency(v2) : "");
    if (!currency) continue;

    const chain = defaultChainFor(currency, cfg.chain_map, DEFAULT_CHAIN_MAP);
    if (chain === "" && !seenUnknownCurrencies.has(currency)) {
      seenUnknownCurrencies.add(currency);
      yield syncWarning("unknown_currency", `No chain mapping for currency: ${currency}`, { currency });
    }

    yield accountDiscoveryFor({
      v3_uuid: v3?.uuid,
      v2_uuid: v2?.id,
      display_name: display,
      currency,
    });

    const accountId = `coinbase:${v3?.uuid ?? v2!.id}`;
    const todayQty = v3 ? parseFloat(v3.available_balance.value) : null;

    if (v2) {
      let txns: V2Transaction[];
      try {
        txns = await fetchV2Transactions({
          fetchJson: ctx.fetchJson,
          baseUrl: BASE_URL,
          buildJwt,
          userAgent: USER_AGENT,
          accountId: v2.id,
        });
      } catch (err) {
        yield syncWarning(
          "v2_transactions_failed",
          `Failed to fetch transactions for ${display}`,
          { wallet: display, error: String(err) },
        );
        if (todayQty != null && todayQty > 0) {
          yield* emitTodayPositionSnapshot({
            priceProvider: ctx.priceProvider,
            symbol: currency,
            chain,
            asOf: today,
            qty: todayQty,
            accountId,
          });
        }
        continue;
      }

      for (const t of txns) {
        yield rawEventFromV2Txn(t);
      }

      const { snapshots, warnings } = await runQuantityWalk({
        txns,
        symbol: currency,
        chain,
        contract_address: "",
        todayDate: today,
        todayQty,
        priceProvider: ctx.priceProvider,
      });
      for (const w of warnings) {
        yield syncWarningFromWalk(w);
      }
      for (const s of snapshots) {
        yield positionSnapshotFor({
          account_id: accountId,
          symbol: currency,
          chain,
          as_of: s.as_of,
          qty: s.qty,
          price_usd: s.price_usd,
        });
      }
    } else if (v3) {
      if (todayQty != null && todayQty > 0) {
        yield* emitTodayPositionSnapshot({
          priceProvider: ctx.priceProvider,
          symbol: currency,
          chain,
          asOf: today,
          qty: todayQty,
          accountId,
        });
      }
    }
  }
}
