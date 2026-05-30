/** diagnose symbol <SYM>
 *
 * Every mention of a symbol across positions, position_snapshots,
 * balance_assertions, raw_events, asset_prices. Highlights ingestion
 * gaps (e.g. "in raw_events but not in positions"). */

import { db, fmtUSD, padR } from "./lib";

export function run(args: string[]): number {
  const sym = args[0];
  if (!sym) { console.error("usage: diagnose symbol <SYMBOL>"); return 1; }
  const S = sym.toUpperCase();
  console.log(`\n=== Symbol: ${S} ===\n`);

  // Positions
  const positions = db.prepare(
    `SELECT id, account_id, chain, contract_address, symbol FROM positions
     WHERE UPPER(symbol) = ?`
  ).all(S) as Array<{ id: number; account_id: string; chain: string; contract_address: string; symbol: string }>;

  console.log(`positions (${positions.length}):`);
  for (const p of positions) {
    const ct = p.contract_address ? ` ${p.contract_address.slice(0, 12)}…` : "";
    console.log(`  [${p.id}] ${p.account_id}  chain=${p.chain}${ct}`);
  }

  // position_snapshots by source
  const snapStats = db.prepare(
    `SELECT ps.source, COUNT(*) n, MIN(ps.as_of) first, MAX(ps.as_of) last,
            ROUND(MAX(ps.value_usd), 0) peak
     FROM position_snapshots ps JOIN positions p ON p.id = ps.position_id
     WHERE UPPER(p.symbol) = ? GROUP BY ps.source ORDER BY n DESC`
  ).all(S) as Array<{ source: string; n: number; first: string; last: string; peak: number }>;
  console.log(`\nposition_snapshots (${snapStats.reduce((a, r) => a + r.n, 0)} rows):`);
  if (snapStats.length === 0) console.log("  — none —");
  for (const r of snapStats) {
    console.log(`  ${r.source.padEnd(30)}  ${String(r.n).padStart(6)} rows   ${r.first} → ${r.last}   peak=${fmtUSD(r.peak)}`);
  }

  // balance_assertions (by symbol? assertions don't have symbol; skip)

  // asset_prices
  const prices = db.prepare(
    `SELECT source, COUNT(*) n, MIN(as_of) first, MAX(as_of) last,
            ROUND(MIN(price_usd), 4) min_p, ROUND(MAX(price_usd), 2) max_p
     FROM asset_prices WHERE UPPER(symbol) = ? GROUP BY source ORDER BY n DESC`
  ).all(S) as Array<{ source: string; n: number; first: string; last: string; min_p: number; max_p: number }>;
  console.log(`\nasset_prices (${prices.reduce((a, r) => a + r.n, 0)} rows):`);
  if (prices.length === 0) console.log("  — none — (blocks alchemy-history backfill)");
  for (const r of prices) {
    console.log(`  ${r.source.padEnd(30)}  ${String(r.n).padStart(6)} rows   ${r.first} → ${r.last}   [${r.min_p} … ${r.max_p}]`);
  }

  // raw_events — scan payload for symbol strings (case-insensitive)
  const re = db.prepare(
    `SELECT source, COUNT(*) n FROM raw_events
     WHERE UPPER(payload) LIKE ? OR UPPER(payload) LIKE ?
     GROUP BY source ORDER BY n DESC`
  ).all(`%"${S}"%`, `%${S}%`) as Array<{ source: string; n: number }>;
  console.log(`\nraw_events mentions (payload match, approximate):`);
  if (re.length === 0) console.log("  — none —");
  for (const r of re) {
    console.log(`  ${r.source.padEnd(30)}  ${String(r.n).padStart(6)} rows`);
  }

  // Gap summary
  console.log(`\n─── gap summary ───`);
  if (re.length > 0 && positions.length === 0) {
    console.log(`  ⚠ appears in raw_events (${re.map(r => r.source).join(", ")}) but NO positions row.`);
  }
  if (positions.length > 0 && snapStats.length === 0) {
    console.log(`  ⚠ position exists but NO snapshots.`);
  }
  if (prices.length === 0 && positions.length > 0) {
    console.log(`  ⚠ NO asset_prices rows — alchemy-history backfill would skip this symbol.`);
  }
  if (positions.length === 0 && re.length === 0 && snapStats.length === 0 && prices.length === 0) {
    console.log(`  ✓ symbol not present anywhere in DB.`);
  }
  console.log();
  return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
