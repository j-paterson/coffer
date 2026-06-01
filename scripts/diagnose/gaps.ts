/** diagnose gaps
 *
 * Coverage audit. Produces several "what's missing" reports:
 *   1. Positions with zero snapshots.
 *   2. Position_snapshots rows referencing a source not in data_sources.
 *   3. Balance_assertions sources not in data_sources. */

import { db } from "./lib";

export function run(_args: string[]): number {
  console.log(`\n=== Gap audit ===\n`);

  // 1. Positions with zero snapshots.
  const orphanPositions = db.prepare(`
    SELECT p.id, p.symbol, p.account_id
    FROM positions p LEFT JOIN position_snapshots ps ON ps.position_id = p.id
    GROUP BY p.id HAVING COUNT(ps.id) = 0
  `).all() as Array<{ id: number; symbol: string; account_id: string }>;
  console.log(`--- 1. Positions with zero snapshots (${orphanPositions.length}) ---`);
  for (const p of orphanPositions.slice(0, 20)) {
    console.log(`  [${p.id}] ${p.symbol.padEnd(10)} ${p.account_id}`);
  }
  if (orphanPositions.length > 20) console.log(`  … and ${orphanPositions.length - 20} more`);
  console.log();

  // 2. Unknown sources in position_snapshots (not registered).
  const unknown = db.prepare(`
    SELECT ps.source, COUNT(*) n FROM position_snapshots ps
    LEFT JOIN data_sources ds ON ds.name = ps.source AND ds.kind = 'snapshot'
    WHERE ds.name IS NULL GROUP BY ps.source ORDER BY n DESC
  `).all() as Array<{ source: string; n: number }>;
  console.log(`--- 2. position_snapshots sources NOT in data_sources registry ---`);
  if (unknown.length === 0) console.log("  ✓ all snapshot sources are registered.");
  for (const r of unknown) console.log(`  ${r.source.padEnd(30)} ${r.n} rows`);
  console.log();

  // 3. Assertion sources not in registry.
  const unknownA = db.prepare(`
    SELECT ba.source, COUNT(*) n FROM balance_assertions ba
    LEFT JOIN data_sources ds ON ds.name = ba.source AND ds.kind = 'assertion'
    WHERE ds.name IS NULL GROUP BY ba.source ORDER BY n DESC
  `).all() as Array<{ source: string; n: number }>;
  console.log(`--- 3. balance_assertions sources NOT in data_sources registry ---`);
  if (unknownA.length === 0) console.log("  ✓ all assertion sources are registered.");
  for (const r of unknownA) console.log(`  ${r.source.padEnd(30)} ${r.n} rows`);
  console.log();

  return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
