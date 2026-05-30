/** diagnose gaps [--min-txns N] [--min-value USD]
 *
 * Coverage audit. Produces several "what's missing" reports:
 *   1. Symbols mentioned in cointracker raw_events but with no asset_prices
 *      coverage — these are what would be invisible if we retire CoinTracker.
 *   2. Positions with zero snapshots.
 *   3. Accounts where every registered snapshot source is disabled.
 *   4. Position_snapshots rows referencing a source not in data_sources. */

import { db, fmtUSD, padR } from "./lib";

export function run(args: string[]): number {
  let minTxns = 1;
  let minValue = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-txns") minTxns = parseInt(args[++i], 10);
    else if (args[i] === "--min-value") minValue = parseFloat(args[++i]);
  }

  console.log(`\n=== Gap audit (min-txns=${minTxns}, min-value=${fmtUSD(minValue)}) ===\n`);

  // 1. Cointracker symbols without asset_prices.
  console.log(`--- 1. CoinTracker symbols with no asset_prices ---`);
  const rows = db.prepare(`SELECT payload FROM raw_events WHERE source='cointracker'`).all() as Array<{ payload: string }>;
  const count = new Map<string, number>();
  const peakValue = new Map<string, number>();
  for (const r of rows) {
    let p: Record<string, string>;
    try { p = JSON.parse(r.payload); } catch { continue; }
    for (const key of ["Sent Currency", "Received Currency", "Fee Currency"]) {
      const v = p[key];
      if (!v || typeof v !== "string") continue;
      const s = v.trim().toUpperCase();
      if (!s) continue;
      count.set(s, (count.get(s) ?? 0) + 1);
    }
    // Track peak per-row cost basis as "historical value" signal.
    for (const [curKey, cbKey] of [
      ["Sent Currency", "Sent Cost Basis (USD)"],
      ["Received Currency", "Received Cost Basis (USD)"],
    ]) {
      const sym = (p[curKey] ?? "").trim().toUpperCase();
      const cb = parseFloat(p[cbKey] ?? "0");
      if (!sym || !(cb > 0)) continue;
      if (cb > (peakValue.get(sym) ?? 0)) peakValue.set(sym, cb);
    }
  }

  type Row = { symbol: string; ct_txns: number; peak_cb: number; has_prices: boolean; has_position: boolean };
  const report: Row[] = [];
  for (const [s, n] of count) {
    if (n < minTxns) continue;
    const peak = peakValue.get(s) ?? 0;
    if (peak < minValue) continue;
    const hp = db.prepare("SELECT 1 FROM asset_prices WHERE UPPER(symbol) = ? LIMIT 1").get(s) !== null;
    const hpos = db.prepare("SELECT 1 FROM positions WHERE UPPER(symbol) = ? LIMIT 1").get(s) !== null;
    report.push({ symbol: s, ct_txns: n, peak_cb: peak, has_prices: hp, has_position: hpos });
  }
  report.sort((a, b) => b.peak_cb - a.peak_cb);
  console.log(`${"symbol".padEnd(15)}  ${padR("ct_txns", 8)}  ${padR("peak_cb", 12)}  prices  position`);
  console.log("─".repeat(70));
  let gapCount = 0;
  for (const r of report) {
    if (r.has_prices) continue;
    gapCount++;
    console.log(`${r.symbol.padEnd(15)}  ${padR(String(r.ct_txns), 8)}  ${padR(fmtUSD(r.peak_cb), 12)}  ${r.has_prices ? "✓" : "✗"}       ${r.has_position ? "✓" : "✗"}`);
  }
  console.log(`\n  → ${gapCount} symbols mentioned by CoinTracker have no asset_prices coverage`);
  console.log(`    (blocks alchemy-history backfill for those tokens)\n`);

  // 2. Positions with zero snapshots.
  const orphanPositions = db.prepare(`
    SELECT p.id, p.symbol, p.account_id
    FROM positions p LEFT JOIN position_snapshots ps ON ps.position_id = p.id
    GROUP BY p.id HAVING COUNT(ps.id) = 0
  `).all() as Array<{ id: number; symbol: string; account_id: string }>;
  console.log(`--- 2. Positions with zero snapshots (${orphanPositions.length}) ---`);
  for (const p of orphanPositions.slice(0, 20)) {
    console.log(`  [${p.id}] ${p.symbol.padEnd(10)} ${p.account_id}`);
  }
  if (orphanPositions.length > 20) console.log(`  … and ${orphanPositions.length - 20} more`);
  console.log();

  // 3. Unknown sources in position_snapshots (not registered).
  const unknown = db.prepare(`
    SELECT ps.source, COUNT(*) n FROM position_snapshots ps
    LEFT JOIN data_sources ds ON ds.name = ps.source AND ds.kind = 'snapshot'
    WHERE ds.name IS NULL GROUP BY ps.source ORDER BY n DESC
  `).all() as Array<{ source: string; n: number }>;
  console.log(`--- 3. position_snapshots sources NOT in data_sources registry ---`);
  if (unknown.length === 0) console.log("  ✓ all snapshot sources are registered.");
  for (const r of unknown) console.log(`  ${r.source.padEnd(30)} ${r.n} rows`);
  console.log();

  // 4. Assertion sources not in registry.
  const unknownA = db.prepare(`
    SELECT ba.source, COUNT(*) n FROM balance_assertions ba
    LEFT JOIN data_sources ds ON ds.name = ba.source AND ds.kind = 'assertion'
    WHERE ds.name IS NULL GROUP BY ba.source ORDER BY n DESC
  `).all() as Array<{ source: string; n: number }>;
  console.log(`--- 4. balance_assertions sources NOT in data_sources registry ---`);
  if (unknownA.length === 0) console.log("  ✓ all assertion sources are registered.");
  for (const r of unknownA) console.log(`  ${r.source.padEnd(30)} ${r.n} rows`);
  console.log();

  return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
