/** diagnose source <name>
 *
 * What a named data source contributes:
 *   - registry row (kind, rank, enabled)
 *   - row counts across position_snapshots, balance_assertions, raw_events
 *   - symbols and accounts covered
 *   - date range
 */

import { db, fmtUSD, padR } from "./lib";

export function run(args: string[]): number {
  const src = args[0];
  if (!src) { console.error("usage: diagnose source <name>"); return 1; }
  console.log(`\n=== Source: ${src} ===\n`);

  const reg = db.prepare("SELECT name, kind, trust_rank, enabled FROM data_sources WHERE name = ?").all(src) as Array<{
    name: string; kind: string; trust_rank: number; enabled: number;
  }>;
  if (reg.length === 0) {
    console.log(`  ⚠ not registered in data_sources table.`);
  } else {
    console.log(`data_sources registry:`);
    for (const r of reg) {
      console.log(`  kind=${r.kind.padEnd(10)} rank=${r.trust_rank}  enabled=${r.enabled ? "YES" : "NO"}`);
    }
  }

  // position_snapshots
  const ps = db.prepare(
    `SELECT COUNT(*) n, MIN(as_of) first, MAX(as_of) last,
            COUNT(DISTINCT position_id) positions,
            ROUND(SUM(value_usd),0) total_abs_value
     FROM position_snapshots WHERE source = ?`
  ).get(src) as { n: number; first: string | null; last: string | null; positions: number; total_abs_value: number | null };
  console.log(`\nposition_snapshots: ${ps.n ?? 0} rows across ${ps.positions ?? 0} positions`);
  if (ps.n > 0) console.log(`  dates ${ps.first} → ${ps.last}`);

  if (ps.n > 0) {
    const top = db.prepare(
      `SELECT p.symbol, COUNT(*) n, ROUND(MAX(ps.value_usd),0) peak
       FROM position_snapshots ps JOIN positions p ON p.id = ps.position_id
       WHERE ps.source = ? GROUP BY p.symbol ORDER BY n DESC LIMIT 15`
    ).all(src) as Array<{ symbol: string; n: number; peak: number }>;
    console.log(`  top symbols:`);
    for (const r of top) console.log(`    ${r.symbol.padEnd(15)} ${String(r.n).padStart(6)} rows   peak=${fmtUSD(r.peak)}`);
  }

  // balance_assertions
  const ba = db.prepare(
    `SELECT COUNT(*) n, MIN(as_of) first, MAX(as_of) last,
            COUNT(DISTINCT account_id) accounts
     FROM balance_assertions WHERE source = ?`
  ).get(src) as { n: number; first: string | null; last: string | null; accounts: number };
  console.log(`\nbalance_assertions: ${ba.n ?? 0} rows across ${ba.accounts ?? 0} accounts`);
  if (ba.n > 0) console.log(`  dates ${ba.first} → ${ba.last}`);

  // raw_events
  const re = db.prepare(
    `SELECT COUNT(*) n, MIN(ingested_at) first, MAX(ingested_at) last
     FROM raw_events WHERE source = ?`
  ).get(src) as { n: number; first: string | null; last: string | null };
  console.log(`\nraw_events: ${re.n ?? 0} rows`);
  if (re.n > 0) console.log(`  ingested ${re.first ?? "?"} → ${re.last ?? "?"}`);

  // asset_prices
  const ap = db.prepare(
    `SELECT COUNT(*) n, MIN(as_of) first, MAX(as_of) last, COUNT(DISTINCT symbol) syms
     FROM asset_prices WHERE source = ?`
  ).get(src) as { n: number; first: string | null; last: string | null; syms: number };
  console.log(`\nasset_prices: ${ap.n ?? 0} rows across ${ap.syms ?? 0} symbols`);
  if (ap.n > 0) console.log(`  dates ${ap.first} → ${ap.last}`);

  console.log();
  return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
