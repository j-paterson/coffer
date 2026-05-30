#!/usr/bin/env bun
/** Backfill asset_prices via DefiLlama — chain + contract authoritative.
 *
 * Reads CANONICAL_TOKENS (canonical_tokens.ts) and for each entry fetches
 * daily prices from coins.llama.fi. Writes rows keyed by the full
 * (chain, contract_address, symbol, as_of, source) — no more
 * symbol-only lookups. Downstream pricing logic must match by
 * (chain, contract_address).
 *
 * Usage:
 *   bun run scripts/backfill/defillama_prices.ts            # full canonical list
 *   bun run scripts/backfill/defillama_prices.ts DEGEN      # single symbol (all chains)
 *   bun run scripts/backfill/defillama_prices.ts --since 2023-01-01
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { BLESSED_TOKENS, type BlessedToken } from "./blessed_contracts";
import { MANUAL_BLESSED_TOKENS } from "./blessed_manual";
// Merge derived + manual; first-seen wins on (chain, contract). Manual
// entries go first so they can't be shadowed by a derived duplicate.
const CANONICAL_TOKENS: BlessedToken[] = (() => {
  const seen = new Set<string>();
  const out: BlessedToken[] = [];
  for (const t of [...MANUAL_BLESSED_TOKENS, ...BLESSED_TOKENS]) {
    const key = `${t.chain}|${t.contract_address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
})();
type CanonicalToken = BlessedToken;

const DB_PATH = resolve(import.meta.dir, "../../db/finance.sqlite");
const DEFAULT_SINCE = "2017-01-01";
const SPAN = 500;      // DefiLlama chunk cap
const DELAY_MS = 600;  // polite — ~1.7 req/s

async function fetchChunk(defillamaId: string, startTs: number, span: number): Promise<Array<{ ts: number; px: number }>> {
  const url = `https://coins.llama.fi/chart/${defillamaId}?start=${startTs}&span=${span}&period=1d`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  type LlamaCoin = { prices?: Array<{ timestamp: number; price: number }> };
  const j = await r.json() as { coins?: Record<string, LlamaCoin> };
  const coin = j.coins?.[defillamaId];
  if (!coin) return [];
  return (coin.prices ?? []).map((p) => ({ ts: p.timestamp, px: p.price }));
}

const isoDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

async function hasCoverage(defillamaId: string): Promise<boolean> {
  // Probe /prices/current to see if DefiLlama has this token at all.
  // Avoids spending 7 chunks × 600ms on contracts it doesn't cover.
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${defillamaId}`);
    if (!r.ok) return false;
    const j = await r.json() as { coins?: Record<string, unknown> };
    return Boolean(j.coins?.[defillamaId]);
  } catch {
    return false;
  }
}

async function backfillToken(db: Database, token: CanonicalToken, sinceISO: string): Promise<number> {
  // Skip if already priced (resume-safe).
  const existing = db.prepare(
    `SELECT COUNT(*) AS n FROM asset_prices
     WHERE chain = ? AND contract_address = ? AND source = 'defillama'`
  ).get(token.chain, token.contract_address) as { n: number };
  if (existing.n > 0) {
    console.log(`  ${token.symbol} ${token.chain}${token.contract_address ? " " + token.contract_address.slice(0, 10) : ""} — already priced (${existing.n} rows), skip`);
    return 0;
  }

  // Probe first: skip tokens DefiLlama has no coverage for.
  const label = `${token.symbol} ${token.chain}${token.contract_address ? " " + token.contract_address.slice(0, 10) : ""}`;
  if (!(await hasCoverage(token.defillama_id))) {
    console.log(`  ${label.padEnd(40)} — no DefiLlama coverage, skip`);
    return 0;
  }

  const sinceTs = Math.floor(new Date(sinceISO + "T00:00:00Z").getTime() / 1000);
  const nowTs = Math.floor(Date.now() / 1000);
  const totalDays = Math.ceil((nowTs - sinceTs) / 86400);
  const chunks = Math.ceil(totalDays / SPAN);

  const upsert = db.prepare(`
    INSERT INTO asset_prices (chain, contract_address, symbol, as_of, source, price_usd)
    VALUES (?, ?, ?, ?, 'defillama', ?)
    ON CONFLICT(chain, contract_address, symbol, as_of, source) DO UPDATE SET
      price_usd = excluded.price_usd,
      ingested_at = CURRENT_TIMESTAMP
  `);

  let written = 0;
  const seenDates = new Set<string>();

  for (let i = 0; i < chunks; i++) {
    const chunkStart = sinceTs + i * SPAN * 86400;
    if (chunkStart >= nowTs) break;
    const span = Math.min(SPAN, Math.ceil((nowTs - chunkStart) / 86400) + 1);
    process.stdout.write(`\r  ${label.padEnd(40)} chunk ${i + 1}/${chunks} ...`);
    try {
      const pts = await fetchChunk(token.defillama_id, chunkStart, span);
      db.exec("BEGIN");
      for (const p of pts) {
        const d = isoDate(p.ts);
        if (seenDates.has(d)) continue;
        seenDates.add(d);
        if (!(p.px > 0)) continue;
        upsert.run(token.chain, token.contract_address, token.symbol, d, p.px);
        written++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      console.error(`\n  ${label} chunk ${i + 1} error: ${(e as Error).message}`);
    }
    if (i < chunks - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }
  process.stdout.write(`\r  ${label.padEnd(40)} ✓ ${written} rows (${seenDates.size} dates)\n`);
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  let since = DEFAULT_SINCE;
  const filters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") since = args[++i];
    else if (args[i].startsWith("--")) { console.error(`unknown flag: ${args[i]}`); process.exit(1); }
    else filters.push(args[i].toUpperCase());
  }
  const targets = filters.length
    ? CANONICAL_TOKENS.filter(t => filters.includes(t.symbol))
    : CANONICAL_TOKENS;

  console.log(`DefiLlama backfill — ${targets.length} canonical tokens, since ${since}`);
  const db = new Database(DB_PATH);
  let totalWritten = 0;
  const failures: string[] = [];
  for (const token of targets) {
    try {
      totalWritten += await backfillToken(db, token, since);
    } catch (e) {
      console.error(`  ${token.symbol} ${token.chain} FAILED: ${(e as Error).message}`);
      failures.push(`${token.symbol}/${token.chain}`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  db.close();
  console.log(`\nDone. ${totalWritten} rows written across ${targets.length} tokens.`);
  if (failures.length) console.log(`failed: ${failures.join(", ")}`);
}

main();
