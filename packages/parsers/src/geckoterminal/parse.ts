import type { Operation, SyncWarning } from "@coffer/ledger/runner";
import type { ParserContext } from "../types/parser";
import { fetchPoolList, fetchOhlcv } from "./client";
import {
  pickHighestLiquidityPool,
  ohlcvToPriceOps,
} from "./mapper";
import type { GeckoTerminalConfig, GeckoTerminalTarget } from "./config";
import { DEFAULT_CHAIN_SLUGS } from "./config";
import { makeTokenBucket, type MakeTokenBucketOpts } from "../shared/rate-limit";
import { HttpStatusError } from "../http/errors";
import type { FetchJson } from "../types/http";

function warning(scope: string, message: string, detail: unknown): Operation {
  const w: SyncWarning = { source: "geckoterminal", scope, message, detail };
  return { kind: "sync_warning", warning: w };
}

function fromIso(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  return Math.floor(Date.parse(`${s}T00:00:00Z`) / 1000);
}

function cacheKey(target: GeckoTerminalTarget): string {
  return `geckoterminal:pool:${target.chain}:${target.contract.toLowerCase()}`;
}

interface CachedPool { pool_address: string }

export interface SyncGeckoTerminalInternalOpts {
  bucketOpts?: Partial<Omit<MakeTokenBucketOpts, "ratePerMinute">>;
}

export async function* syncGeckoTerminal(
  ctx: ParserContext<GeckoTerminalConfig>,
  internal: SyncGeckoTerminalInternalOpts = {},
): AsyncGenerator<Operation> {
  const config = ctx.config;
  const chainSlugMap: Record<string, string> = { ...DEFAULT_CHAIN_SLUGS, ...config.chain_slugs };
  const bucket = makeTokenBucket({
    ratePerMinute: config.rate_per_minute,
    ...internal.bucketOpts,
  });

  const gated: FetchJson = async <T>(url: string | URL, opts?: import("../types/http").FetchJsonOpts) => {
    await bucket.acquire();
    return ctx.fetchJson<T>(url, opts);
  };

  for (const target of config.targets) {
    const slug = chainSlugMap[target.chain];
    if (slug === undefined) continue; // silent skip

    const poolAddress = yield* resolvePool(ctx, gated, target, slug);
    if (poolAddress === null) continue;

    yield* walkOhlcv(ctx, gated, target, slug, poolAddress);
  }
}

async function* resolvePool(
  ctx: ParserContext<GeckoTerminalConfig>,
  gated: FetchJson,
  target: GeckoTerminalTarget,
  slug: string,
): AsyncGenerator<Operation, string | null> {
  const key = cacheKey(target);
  const cached = await ctx.cache.get<CachedPool>(key);
  if (cached !== null) return cached.pool_address;
  return yield* freshResolve(ctx, gated, target, slug, key);
}

async function* freshResolve(
  ctx: ParserContext<GeckoTerminalConfig>,
  gated: FetchJson,
  target: GeckoTerminalTarget,
  slug: string,
  key: string,
): AsyncGenerator<Operation, string | null> {
  let response;
  try {
    response = await fetchPoolList({ fetchJson: gated, network: slug, contract: target.contract });
  } catch (err) {
    yield warning(
      "pool_lookup_failed",
      `pool list failed for ${target.chain}:${target.contract}`,
      { chain: target.chain, contract: target.contract, error: errString(err) },
    );
    return null;
  }
  const pick = pickHighestLiquidityPool(response, slug);
  if (pick === null) {
    yield warning(
      "no_pool",
      `no usable pool for ${target.chain}:${target.contract}`,
      { chain: target.chain, contract: target.contract },
    );
    return null;
  }
  await ctx.cache.set<CachedPool>(
    key,
    { pool_address: pick.pool_address },
    ctx.config.pool_cache_ttl_seconds,
  );
  return pick.pool_address;
}

async function* walkOhlcv(
  ctx: ParserContext<GeckoTerminalConfig>,
  gated: FetchJson,
  target: GeckoTerminalTarget,
  slug: string,
  poolAddressInitial: string,
): AsyncGenerator<Operation> {
  let poolAddress = poolAddressInitial;
  const key = cacheKey(target);
  const fromTs = fromIso(target.from, 0);
  const toTs = fromIso(target.to, Math.floor(ctx.now().getTime() / 1000));

  let beforeTs = toTs;
  let staleRecovered = false;

  while (true) {
    let page;
    try {
      page = await fetchOhlcv({
        fetchJson: gated,
        network: slug,
        pool: poolAddress,
        beforeTimestamp: beforeTs,
      });
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404 && !staleRecovered) {
        await ctx.cache.delete(key);
        const fresh = yield* freshResolve(ctx, gated, target, slug, key);
        if (fresh === null) return;
        poolAddress = fresh;
        staleRecovered = true;
        continue;
      }
      yield warning(
        "ohlcv_failed",
        `ohlcv fetch failed for ${target.chain}:${target.contract}`,
        { chain: target.chain, contract: target.contract, pool: poolAddress, error: errString(err) },
      );
      return;
    }

    const points = page.data?.attributes?.ohlcv_list ?? [];
    yield* ohlcvToPriceOps(points, target, fromTs);

    if (points.length < 1000) return;
    const oldestTs = points[points.length - 1]![0];
    if (oldestTs <= fromTs) return;
    if (oldestTs >= beforeTs) return;
    beforeTs = oldestTs;
  }
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
