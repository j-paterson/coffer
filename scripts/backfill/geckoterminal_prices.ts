#!/usr/bin/env bun
/** GeckoTerminal historical price backfill — coverage for tokens that
 * DefiLlama doesn't price.
 *
 * Motivation: DEX-only memecoins and airdrops (ACE, random base tokens)
 * never make it into DefiLlama's aggregator but do have GeckoTerminal
 * pools. This script fills the gap so walkV2 stops labeling them
 * "Unidentified" on the wallet breakdown chart.
 *
 * For every (chain, contract) in `positions` that has no row in
 * `asset_prices` yet, hit GeckoTerminal:
 *   1. /networks/{gt_chain}/tokens/{contract}   — finds top pool
 *   2. /networks/{gt_chain}/pools/{pool}/ohlcv/day?limit=1000
 *      paginated via `before_timestamp` back to token genesis.
 *
 * Write price = close of each daily candle with source='geckoterminal'.
 *
 * Rate limit: GT free tier is 30 req/min. We throttle at 2.1s between
 * calls to stay well under.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../../db/finance.sqlite");
const DELAY_MS = 2100;

// Our chain names → GeckoTerminal network slugs.
const GT_CHAIN: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  optimism: "optimism",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  avalanche: "avax",
  scroll: "scroll",
  unichain: "unichain",
  zora: "zora",
};

type TokenCandidate = {
  chain: string;
  contract: string;
  symbol: string;
};

type OHLCV = [number, number, number, number, number, number];

const db = new Database(DB_PATH);

function enumerateCandidates(): TokenCandidate[] {
  // Positions with a real contract that have ZERO rows in asset_prices
  // for the same (chain, contract). Skip natives (contract='').
  const rows = db.prepare(
    `SELECT DISTINCT p.chain, p.contract_address AS contract, p.symbol
     FROM positions p
     WHERE p.contract_address != ''
       AND NOT EXISTS (
         SELECT 1 FROM asset_prices ap
         WHERE ap.chain = p.chain
           AND ap.contract_address = p.contract_address
       )`,
  ).all() as Array<{ chain: string; contract: string; symbol: string }>;
  return rows;
}

async function fetchTopPool(gtChain: string, contract: string): Promise<string | null> {
  const url = `https://api.geckoterminal.com/api/v2/networks/${gtChain}/tokens/${contract}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  type GtTokenResponse = { data?: { relationships?: { top_pools?: { data?: Array<{ id: string }> } } } };
  const j = await r.json() as GtTokenResponse;
  const pool = j.data?.relationships?.top_pools?.data?.[0]?.id;
  if (!pool || typeof pool !== "string") return null;
  return pool.replace(/^[^_]+_/, ""); // strip 'base_' etc
}

async function fetchOhlcv(gtChain: string, pool: string, beforeTs?: number): Promise<OHLCV[]> {
  const params = new URLSearchParams({ limit: "1000", aggregate: "1" });
  if (beforeTs) params.set("before_timestamp", String(beforeTs));
  const url = `https://api.geckoterminal.com/api/v2/networks/${gtChain}/pools/${pool}/ohlcv/day?${params}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return [];
  type GtOhlcvResponse = { data?: { attributes?: { ohlcv_list?: OHLCV[] } } };
  const j = await r.json() as GtOhlcvResponse;
  return (j.data?.attributes?.ohlcv_list ?? []) as OHLCV[];
}

const isoDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

async function backfillToken(cand: TokenCandidate): Promise<number> {
  const gtChain = GT_CHAIN[cand.chain];
  if (!gtChain) return 0;

  const label = `${cand.symbol.padEnd(10)} ${cand.chain.padEnd(10)} ${cand.contract.slice(0, 10)}…`;
  await new Promise((r) => setTimeout(r, DELAY_MS));
  const pool = await fetchTopPool(gtChain, cand.contract);
  if (!pool) {
    console.log(`  ${label} no pool — skip`);
    return 0;
  }

  const upsert = db.prepare(`
    INSERT INTO asset_prices (chain, contract_address, symbol, as_of, source, price_usd)
    VALUES (?, ?, ?, ?, 'geckoterminal', ?)
    ON CONFLICT(chain, contract_address, symbol, as_of, source) DO UPDATE SET
      price_usd = excluded.price_usd,
      ingested_at = CURRENT_TIMESTAMP
  `);

  let written = 0;
  const seen = new Set<string>();
  let beforeTs: number | undefined = undefined;

  for (let page = 0; page < 20; page++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    const points = await fetchOhlcv(gtChain, pool, beforeTs);
    if (points.length === 0) break;

    db.exec("BEGIN");
    for (const [ts, , , , close] of points) {
      const d = isoDate(ts);
      if (seen.has(d)) continue;
      seen.add(d);
      if (!(close > 0)) continue;
      upsert.run(cand.chain, cand.contract, cand.symbol, d, close);
      written++;
    }
    db.exec("COMMIT");

    // Continue paginating to older data.
    const oldest = points[points.length - 1][0];
    if (points.length < 1000) break; // done, no older data
    if (beforeTs !== undefined && oldest >= beforeTs) break; // no progress
    beforeTs = oldest;
  }

  console.log(`  ${label} ✓ ${written} rows (${seen.size} dates)`);
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  const symFilter = args.find((a) => !a.startsWith("--"))?.toUpperCase();
  const candidates = enumerateCandidates().filter(
    (c) => !symFilter || c.symbol.toUpperCase() === symFilter,
  );
  console.log(`GeckoTerminal backfill — ${candidates.length} tokens to try`);

  let totalWritten = 0;
  let successes = 0;
  for (const c of candidates) {
    try {
      const n = await backfillToken(c);
      if (n > 0) {
        totalWritten += n;
        successes++;
      }
    } catch (e) {
      console.error(`  ${c.symbol} ${c.chain} err: ${(e as Error).message}`);
    }
  }
  console.log(`\nDone. ${successes} tokens priced; ${totalWritten} rows written.`);
  db.close();
}

main();
