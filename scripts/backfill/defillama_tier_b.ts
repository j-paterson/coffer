#!/usr/bin/env bun
/** Tier-B price backfill via DefiLlama.
 *
 * Finds every symbol in raw_events (source='cointracker') whose peak
 * historical cost basis was ≥ $1000 AND which lacks asset_prices
 * coverage. Resolves each to a CoinGecko slug via CoinGecko search API,
 * then fetches daily prices from DefiLlama.
 *
 * Excludes obvious non-fungibles and LP tokens by name pattern.
 * Writes prices with source='defillama'. Idempotent (ON CONFLICT).
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../../db/finance.sqlite");
const MIN_PEAK_CB = 1000;
const SPAN = 500;
const LLAMA_DELAY_MS = 600;
const CG_DELAY_MS = 2500; // CoinGecko free tier: 30 req/min; be polite

const EXCLUDE_PATTERNS: RegExp[] = [
  /^UNI-V3-POS/i,
  /^UNI-V2/i,
  /#\d/,           // NFT instance: "COMIC #2274", "DD #0"
  /^USD$/,         // fiat
  /^LL$/i,         // lazy lions shorthand
  / /,             // multi-word (likely custom labels)
];

// Hand-curated overrides — either because CoinGecko search picks the
// wrong coin, or the symbol is ambiguous. Maps SYMBOL → coingecko_id.
const OVERRIDES: Record<string, string> = {
  STETH: "staked-ether",
  RETH: "rocket-pool-eth",
  AERO: "aerodrome-finance",
  VIRTUAL: "virtual-protocol",
  TOBY: "toby",
  HIGHER: "higher",
  CLANKER: "tokenbot-2",
  BRETT: "based-brett",
  MOXIE: "moxie",
  ANON: "anonym",
  BOOMER: "boomer-2",
  BANGER: "banger",
  BRUNETTE: "brunette",
  BLONDE: "blonde",
  PEEPO: "peepo",
  WLFI: "world-liberty-financial",
};

const db = new Database(DB_PATH);
const q = (sql: string, p: (string | number | bigint | boolean | null)[] = []) => db.prepare(sql).all(...p);

function enumerateTierB(): { sym: string; peak_cb: number }[] {
  const rows = q("SELECT payload FROM raw_events WHERE source='cointracker'") as Array<{ payload: string }>;
  const peak = new Map<string, number>();
  for (const r of rows) {
    let p: Record<string, string>; try { p = JSON.parse(r.payload); } catch { continue; }
    for (const [curK, cbK] of [
      ["Sent Currency", "Sent Cost Basis (USD)"],
      ["Received Currency", "Received Cost Basis (USD)"],
    ]) {
      const s = (p[curK] ?? "").trim().toUpperCase();
      if (!s) continue;
      const cb = parseFloat(p[cbK] ?? "0");
      if (!(cb > 0)) continue;
      if (cb > (peak.get(s) ?? 0)) peak.set(s, cb);
    }
  }
  const out: { sym: string; peak_cb: number }[] = [];
  for (const [sym, cb] of peak) {
    if (cb < MIN_PEAK_CB) continue;
    if (EXCLUDE_PATTERNS.some(r => r.test(sym))) continue;
    out.push({ sym, peak_cb: cb });
  }
  // Drop symbols that already have defillama coverage.
  const covered = new Set(
    (q("SELECT DISTINCT symbol FROM asset_prices WHERE source='defillama'") as Array<{ symbol: string }>)
      .map(r => r.symbol.toUpperCase()),
  );
  return out.filter(r => !covered.has(r.sym)).sort((a, b) => b.peak_cb - a.peak_cb);
}

async function resolveCoingeckoSlug(sym: string): Promise<string | null> {
  if (OVERRIDES[sym]) return OVERRIDES[sym];
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`);
    if (!r.ok) return null;
    type CgCoin = { id: string; symbol: string; market_cap_rank: number | null };
    const j = await r.json() as { coins?: CgCoin[] };
    const coins = j.coins ?? [];
    // Prefer exact symbol match, highest market_cap_rank.
    const exact = coins.filter((c) => (c.symbol ?? "").toUpperCase() === sym);
    if (exact.length === 0) return null;
    exact.sort((a, b) => (a.market_cap_rank ?? 9e9) - (b.market_cap_rank ?? 9e9));
    return exact[0].id;
  } catch {
    return null;
  }
}

async function fetchChunk(cgId: string, startTs: number, span: number): Promise<Array<{ ts: number; px: number }>> {
  const url = `https://coins.llama.fi/chart/coingecko:${cgId}?start=${startTs}&span=${span}&period=1d`;
  const r = await fetch(url);
  if (!r.ok) return [];
  type LlamaCoin = { prices?: Array<{ timestamp: number; price: number }> };
  const j = await r.json() as { coins?: Record<string, LlamaCoin> };
  const coin = j.coins?.[`coingecko:${cgId}`];
  return (coin?.prices ?? []).map((p) => ({ ts: p.timestamp, px: p.price }));
}

const isoDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

async function backfill(sym: string, cgId: string): Promise<number> {
  const sinceTs = Math.floor(new Date("2017-01-01T00:00:00Z").getTime() / 1000);
  const nowTs = Math.floor(Date.now() / 1000);
  const days = Math.ceil((nowTs - sinceTs) / 86400);
  const chunks = Math.ceil(days / SPAN);
  const upsert = db.prepare(
    "INSERT INTO asset_prices (symbol, as_of, source, price_usd) VALUES (?, ?, 'defillama', ?) " +
    "ON CONFLICT(symbol, as_of, source) DO UPDATE SET price_usd = excluded.price_usd, ingested_at = CURRENT_TIMESTAMP"
  );
  let written = 0;
  const seen = new Set<string>();
  for (let i = 0; i < chunks; i++) {
    const start = sinceTs + i * SPAN * 86400;
    if (start >= nowTs) break;
    const span = Math.min(SPAN, Math.ceil((nowTs - start) / 86400) + 1);
    try {
      const pts = await fetchChunk(cgId, start, span);
      db.exec("BEGIN");
      for (const p of pts) {
        const d = isoDate(p.ts);
        if (seen.has(d) || !(p.px > 0)) continue;
        seen.add(d);
        upsert.run(sym, d, p.px);
        written++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      console.error(`  ${sym} chunk ${i + 1} err: ${(e as Error).message}`);
    }
    if (i < chunks - 1) await new Promise(r => setTimeout(r, LLAMA_DELAY_MS));
  }
  return written;
}

async function main() {
  const candidates = enumerateTierB();
  console.log(`Tier-B backfill — ${candidates.length} symbols ≥ $${MIN_PEAK_CB} peak CB`);

  const unresolved: string[] = [];
  let totalWritten = 0;
  for (const { sym, peak_cb } of candidates) {
    const slug = await resolveCoingeckoSlug(sym);
    if (!slug) {
      console.log(`  ${sym.padEnd(12)} (peak $${peak_cb.toFixed(0)}) ✗ no CG slug`);
      unresolved.push(`${sym} ($${peak_cb.toFixed(0)})`);
      await new Promise(r => setTimeout(r, CG_DELAY_MS));
      continue;
    }
    // Polite CG pause before DefiLlama call
    await new Promise(r => setTimeout(r, CG_DELAY_MS));
    const n = await backfill(sym, slug);
    console.log(`  ${sym.padEnd(12)} → ${slug.padEnd(25)} ${String(n).padStart(5)} rows`);
    totalWritten += n;
  }
  console.log(`\nDone. ${totalWritten} rows written.`);
  if (unresolved.length) {
    console.log(`\nUnresolved (${unresolved.length}):`);
    for (const s of unresolved) console.log(`  ${s}`);
  }
  db.close();
}

main();
