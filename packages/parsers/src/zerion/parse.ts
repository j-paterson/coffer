import type { Operation } from "@coffer/ledger/runner";
import type { ParserContext } from "../types/parser";
import {
  basicAuthHeader,
  fetchPositions,
  fetchWalletChart,
  fetchFungibleChart,
  USER_AGENT,
  type ZerionPositionsResponse,
  type ZerionChartResponse,
  type ZerionFungibleChartResponse,
} from "./client";
import { mapPositions, mapWalletChart, mapFungiblePrices } from "./mapper";
import type { ZerionConfig } from "./config";

const SOURCE = "zerion";

export async function* syncZerion(
  ctx: ParserContext<ZerionConfig>,
): AsyncGenerator<Operation> {
  const c = ctx.config;

  const apiKey = await ctx.secrets.get(c.api_key_env);
  if (!apiKey) {
    yield {
      kind: "sync_warning",
      warning: { source: SOURCE, scope: "config", message: `${c.api_key_env} is not set` },
    };
    return;
  }
  const authHeader = basicAuthHeader(apiKey);
  if (c.wallets.length === 0) return;

  const asOf = ctx.now().toISOString().slice(0, 10);
  const seenAccounts  = new Set<string>();   // "addrLower:chain"
  const seenFungibles = new Set<string>();   // fungible ids

  // ---------- Phase 1: positions ----------
  for (const addr of c.wallets) {
    let positions: ZerionPositionsResponse;
    try {
      positions = await fetchPositions({
        fetchJson: ctx.fetchJson, baseUrl: c.base_url,
        basicAuthHeader: authHeader, address: addr, userAgent: USER_AGENT,
      });
    } catch (err) {
      yield {
        kind: "sync_warning",
        warning: {
          source: SOURCE, scope: "positions_fetch_failed",
          message: `wallet positions for ${addr} failed: ${(err as Error).message}`,
          detail: { addr },
        },
      };
      continue;
    }

    const { ops, chains, fungibles } = mapPositions(positions, {
      address: addr, asOf, minValueUsd: c.min_value_usd,
    });
    for (const op of ops) yield op;
    const addrLower = addr.toLowerCase();
    for (const chain of chains)  seenAccounts.add(`${addrLower}:${chain}`);
    for (const f of fungibles)   seenFungibles.add(f);
  }

  // ---------- Phase 2: wallet charts ----------
  for (const pair of seenAccounts) {
    const idx = pair.indexOf(":");
    const addr  = pair.slice(0, idx);
    const chain = pair.slice(idx + 1);
    const key = `zerion:wallet-chart:${addr}:${chain}`;
    let chart = await ctx.cache.get<ZerionChartResponse>(key);
    if (!chart) {
      try {
        chart = await fetchWalletChart({
          fetchJson: ctx.fetchJson, baseUrl: c.base_url,
          basicAuthHeader: authHeader, address: addr, chain, userAgent: USER_AGENT,
        });
      } catch (err) {
        yield {
          kind: "sync_warning",
          warning: {
            source: SOURCE, scope: "chart_fetch_failed",
            message: `wallet chart for ${addr}/${chain} failed: ${(err as Error).message}`,
            detail: { addr, chain },
          },
        };
        continue;
      }
      await ctx.cache.set(key, chart, c.chart_cache_ttl_seconds);
    }
    const accountId = `zerion:${chain}:${addr}`;
    for (const op of mapWalletChart(chart, accountId, "zerion-chart")) yield op;
  }

  // ---------- Phase 3: fungible prices ----------
  for (const fungibleId of seenFungibles) {
    const key = `zerion:fungible-chart:${fungibleId}`;
    let chart = await ctx.cache.get<ZerionFungibleChartResponse>(key);
    if (!chart) {
      try {
        chart = await fetchFungibleChart({
          fetchJson: ctx.fetchJson, baseUrl: c.base_url,
          basicAuthHeader: authHeader, fungibleId, userAgent: USER_AGENT,
        });
      } catch (err) {
        yield {
          kind: "sync_warning",
          warning: {
            source: SOURCE, scope: "fungible_fetch_failed",
            message: `fungible chart for ${fungibleId} failed: ${(err as Error).message}`,
            detail: { fungibleId },
          },
        };
        continue;
      }
      await ctx.cache.set(key, chart, c.chart_cache_ttl_seconds);
    }
    for (const op of mapFungiblePrices(chart)) yield op;
  }
}
