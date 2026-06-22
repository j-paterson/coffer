#!/usr/bin/env bun
/**
 * Rebuild db/finance.sqlite from the affluent_household demo fixture.
 *
 * Run: bun scripts/build_demo_db.ts
 *
 * Steps:
 *   1. Back up any existing db/finance.sqlite to *.realmirror.bak (once).
 *   2. Create a fresh db/finance.sqlite, apply migrations.
 *   3. Load db/fixtures/affluent_household.yaml (runs invariant checks).
 *   4. Print a net-worth / institution summary.
 */
import { Database } from "bun:sqlite";
import { existsSync, copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrations } from "../apps/server/src/db";
import { loadScenario } from "../apps/server/test/scenarios";

const ROOT = resolve(import.meta.dir, "..");
const DB_PATH = resolve(ROOT, "db/finance.sqlite");
const BACKUP = resolve(ROOT, "db/finance.sqlite.realmirror.bak");

// 1. Back up the existing (real-mirror) DB once, then clear the live files.
if (existsSync(DB_PATH)) {
  if (!existsSync(BACKUP)) {
    copyFileSync(DB_PATH, BACKUP);
    console.log(`backed up real-mirror DB -> ${BACKUP}`);
  } else {
    console.log(`backup already exists (${BACKUP}); leaving it untouched`);
  }
}
for (const suffix of ["", "-wal", "-shm"]) {
  const f = DB_PATH + suffix;
  if (existsSync(f)) rmSync(f);
}

// 2. Fresh DB + migrations.
const db = new Database(DB_PATH, { create: true, readwrite: true });
db.run("PRAGMA journal_mode = WAL");
applyMigrations(db);

// 3. Load the fixture (validate=true runs all architectural invariants).
loadScenario(db, "affluent_household");

// 3b. Credit-card terms (APR / minimums). debt_terms isn't a fixture-loader
// table, so seed it directly here for a realistic Debt screen.
const debtTerms: Array<[string, number, number, number]> = [
  // account_id, apr, min_payment_pct, min_payment_floor
  ["vesta:cc-2014", 0.2199, 0.02, 35],
  ["northwind:cc-6677", 0.1849, 0.02, 25],
];
for (const [id, apr, pct, floor] of debtTerms) {
  db.run(
    "INSERT INTO debt_terms (account_id, apr, min_payment_pct, min_payment_floor) VALUES (?, ?, ?, ?)",
    [id, apr, pct, floor],
  );
}

// 3c. Crypto cost basis. The holdings route only carries snapshot cost_basis
// for brokerage/retirement; crypto basis comes from cost_basis_overrides.
// Seed symbol-only overrides so BTC/ETH show unrealized P&L (matching the
// first-month snapshot value used as basis in the fixture).
const cryptoBasis: Array<[string, number]> = [
  ["BTC", 13500],
  ["ETH", 7500],
];
for (const [symbol, cost] of cryptoBasis) {
  db.run(
    "INSERT INTO cost_basis_overrides (symbol, account_id, cost_usd) VALUES (?, NULL, ?)",
    [symbol, cost],
  );
}

// 4. Summary.
const fmt = (n: number) =>
  "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const inst = db
  .query(
    "SELECT institution, COUNT(*) n FROM accounts WHERE id NOT LIKE 'equity:%' GROUP BY institution ORDER BY institution",
  )
  .all() as Array<{ institution: string; n: number }>;
console.log("\ninstitutions:");
for (const r of inst) console.log(`  ${r.institution}  (${r.n})`);
const acctCount = db
  .query("SELECT COUNT(*) n FROM accounts WHERE id NOT LIKE 'equity:%'")
  .get() as { n: number };
console.log(`\naccounts (non-equity): ${acctCount.n}`);
console.log("\nDB rebuilt:", DB_PATH);
db.close();
