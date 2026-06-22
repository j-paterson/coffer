import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../db";
import { BUNDLE_TEMPLATES } from "../../lib/bundle_templates";

const here = fileURLToPath(new URL(".", import.meta.url));
// Go up from __tests__/ → routes/ → src/ → api/ → dashboard/ → worktree-root/
const MIGRATIONS_DIR = resolve(here, "../../../../../db/migrations");

/** Apply only migrations whose filename sorts before the given prefix. */
function applyMigrationsBefore(db: Database, prefix: string): void {
  for (const f of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!f.endsWith(".sql")) continue;
    if (f >= prefix) break;
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
  }
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
});

afterEach(() => { db.close(); });

test("042: bundles have category_options column defaulting to []", () => {
  db.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('b1','reno-1','Kitchen','renovation','2026-01-01','2026-01-31',0,0)`
  ).run();
  const row = db
    .prepare(`SELECT category_options FROM bundles WHERE id = ?`)
    .get("b1") as { category_options: string };
  // Raw inserts after migration get the DEFAULT '[]' (route handler will populate;
  // backfill of "existing" bundles is exercised in the integration test below).
  expect(row.category_options).toBe("[]");
  expect(BUNDLE_TEMPLATES.renovation.length).toBeGreaterThan(0);
});

test("042: backfill sets category_options by type for pre-existing bundles", () => {
  // Set up DB state with migrations < 042
  const preMigrationDb = new Database(":memory:");
  applyMigrationsBefore(preMigrationDb, "042_");

  // Seed bundles of each type before the migration runs
  preMigrationDb.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('r1','reno-1','Kitchen','renovation','2026-01-01','2026-01-31',0,0)`
  ).run();
  preMigrationDb.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('t1','trip-1','Paris','trip','2026-02-01','2026-02-14',0,0)`
  ).run();
  preMigrationDb.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('p1','proj-1','Website','project','2026-03-01','2026-03-31',0,0)`
  ).run();

  // Now apply migration 042
  const migrationSql = readFileSync(resolve(MIGRATIONS_DIR, "042_bundle_category_options.sql"), "utf8");
  preMigrationDb.exec(migrationSql);

  // Assert each type got the right category_options from the backfill
  const types: Array<keyof typeof BUNDLE_TEMPLATES> = ["renovation", "trip", "project"];
  const ids: Record<string, string> = { renovation: "r1", trip: "t1", project: "p1" };

  for (const type of types) {
    const row = preMigrationDb
      .prepare(`SELECT category_options FROM bundles WHERE id = ?`)
      .get(ids[type]) as { category_options: string };
    const parsed = JSON.parse(row.category_options);
    expect(parsed).toEqual(BUNDLE_TEMPLATES[type]);
  }

  preMigrationDb.close();
});

test("042: SQL backfill stays in sync with BUNDLE_TEMPLATES constants", () => {
  // This test re-exercises the backfill using the full migration suite
  // (pre-migration state simulated via inline filtered loader).
  const syncDb = new Database(":memory:");
  applyMigrationsBefore(syncDb, "042_");

  // Seed one bundle per type
  for (const [type, id] of [["renovation", "s-r"], ["trip", "s-t"], ["project", "s-p"]] as const) {
    syncDb.prepare(
      `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
       VALUES (?, ?, ?, ?, '2026-01-01', '2026-12-31', 0, 0)`
    ).run(id, `${type}-slug`, type, type);
  }

  // Apply migration 042
  const migrationSql = readFileSync(resolve(MIGRATIONS_DIR, "042_bundle_category_options.sql"), "utf8");
  syncDb.exec(migrationSql);

  // Each type's stored JSON must deep-equal the TS constant
  for (const [type, id] of [["renovation", "s-r"], ["trip", "s-t"], ["project", "s-p"]] as const) {
    const row = syncDb
      .prepare(`SELECT category_options FROM bundles WHERE id = ?`)
      .get(id) as { category_options: string };
    expect(JSON.parse(row.category_options)).toEqual(BUNDLE_TEMPLATES[type]);
  }

  syncDb.close();
});

// ─── Migration 043 tests ───────────────────────────────────────────────────

test("043: every unitemized txn gets one synthesized item", () => {
  const d = new Database(":memory:");
  applyMigrationsBefore(d, "043_");

  // Seed a dummy email so pre-043 transaction_items (which require email_id NOT NULL) can be inserted
  d.prepare(
    `INSERT INTO emails (id, received_at, from_addr, subject, raw_path)
     VALUES ('email-1', '2026-01-02T00:00:00Z', 'shop@amazon.com', 'Order receipt', 'raw/email-1.eml')`
  ).run();

  // Seed an unitemized txn (category='Food', kind=null)
  const unitemized = d.prepare(
    `INSERT INTO transactions_v2 (date, description, category, derived_by)
     VALUES ('2026-01-01', 'Grocery run', 'Food', 'import')
     RETURNING id`
  ).get() as { id: number };

  // Seed an itemized txn with two existing transaction_items rows
  const itemized = d.prepare(
    `INSERT INTO transactions_v2 (date, description, category, derived_by)
     VALUES ('2026-01-02', 'Amazon order', 'Shopping', 'import')
     RETURNING id`
  ).get() as { id: number };

  // Insert two items for the itemized txn referencing the dummy email
  d.prepare(
    `INSERT INTO transaction_items (email_id, line_no, name, transaction_v2_id)
     VALUES ('email-1', 1, 'Widget A', ?)`
  ).run(itemized.id);
  d.prepare(
    `INSERT INTO transaction_items (email_id, line_no, name, transaction_v2_id)
     VALUES ('email-1', 2, 'Widget B', ?)`
  ).run(itemized.id);

  // Apply migration 043
  const migrationSql = readFileSync(resolve(MIGRATIONS_DIR, "043_synthesize_items.sql"), "utf8");
  d.exec(migrationSql);

  // The unitemized txn must have exactly 1 synthesized item with category='Food'
  const unitemizedItems = d.prepare(
    `SELECT * FROM transaction_items WHERE transaction_v2_id = ?`
  ).all(unitemized.id) as Array<{ category: string }>;
  expect(unitemizedItems).toHaveLength(1);
  expect(unitemizedItems[0].category).toBe("Food");

  // The itemized txn must still have exactly 2 rows
  const itemizedItems = d.prepare(
    `SELECT * FROM transaction_items WHERE transaction_v2_id = ?`
  ).all(itemized.id);
  expect(itemizedItems).toHaveLength(2);

  d.close();
});

test("043: NULL-description txn gets one synthesized item with empty-string name", () => {
  const d = new Database(":memory:");
  applyMigrationsBefore(d, "043_");

  // Seed a txn with description=NULL and a category
  const txn = d.prepare(
    `INSERT INTO transactions_v2 (date, description, category, derived_by)
     VALUES ('2026-01-01', NULL, 'Food', 'import')
     RETURNING id`
  ).get() as { id: number };

  // Apply migration 043
  const migrationSql = readFileSync(resolve(MIGRATIONS_DIR, "043_synthesize_items.sql"), "utf8");
  d.exec(migrationSql);

  const items = d.prepare(
    `SELECT * FROM transaction_items WHERE transaction_v2_id = ?`
  ).all(txn.id) as Array<{ name: string; category: string }>;

  // Must have exactly one synthesized item
  expect(items).toHaveLength(1);
  // Category must be preserved
  expect(items[0].category).toBe("Food");
  // Name must be empty string (no description to use)
  expect(items[0].name).toBe("");

  d.close();
});

test("043: kind is used as fallback when category is null", () => {
  const d = new Database(":memory:");
  applyMigrationsBefore(d, "043_");

  // Seed txn with category=NULL, kind='material'
  const txn = d.prepare(
    `INSERT INTO transactions_v2 (date, description, category, kind, derived_by)
     VALUES ('2026-01-01', 'Lumber purchase', NULL, 'material', 'import')
     RETURNING id`
  ).get() as { id: number };

  // Apply migration 043
  const migrationSql = readFileSync(resolve(MIGRATIONS_DIR, "043_synthesize_items.sql"), "utf8");
  d.exec(migrationSql);

  const items = d.prepare(
    `SELECT * FROM transaction_items WHERE transaction_v2_id = ?`
  ).all(txn.id) as Array<{ category: string }>;
  expect(items).toHaveLength(1);
  expect(items[0].category).toBe("material");

  d.close();
});

test("043: synthesized item's line_total equals sum of non-equity postings", () => {
  const d = new Database(":memory:");
  applyMigrationsBefore(d, "043_");

  // Seed a real account (non-equity) so FK on postings.account_id passes
  d.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('acct:test', 'Test Checking', 'TestBank', 'checking', 'USD', 1, 'live')`
  ).run();

  // Seed a txn
  const txn = d.prepare(
    `INSERT INTO transactions_v2 (date, description, category, derived_by)
     VALUES ('2026-01-01', 'Hardware store', 'Home', 'import')
     RETURNING id`
  ).get() as { id: number };

  // Add two postings: one real spend, one equity balancer
  // equity:unknown-counterparty is pre-seeded in migration 021
  d.prepare(
    `INSERT INTO postings (txn_id, account_id, amount, currency, reconciled)
     VALUES (?, 'acct:test', -50, 'USD', 0)`
  ).run(txn.id);
  d.prepare(
    `INSERT INTO postings (txn_id, account_id, amount, currency, reconciled)
     VALUES (?, 'equity:unknown-counterparty', 50, 'USD', 0)`
  ).run(txn.id);

  // Apply migration 043
  const migrationSql = readFileSync(resolve(MIGRATIONS_DIR, "043_synthesize_items.sql"), "utf8");
  d.exec(migrationSql);

  const items = d.prepare(
    `SELECT line_total FROM transaction_items WHERE transaction_v2_id = ?`
  ).all(txn.id) as Array<{ line_total: number }>;
  expect(items).toHaveLength(1);
  expect(items[0].line_total).toBe(-50);

  d.close();
});

// ─── Migration 044 tests ───────────────────────────────────────────────────

test("044: kind and transactions_v2.category columns are gone", () => {
  // db is set up by beforeEach with applyMigrations(db) — full suite including 044
  const txnCols = db.prepare("PRAGMA table_info(transactions_v2)").all() as { name: string }[];
  const itemCols = db.prepare("PRAGMA table_info(transaction_items)").all() as { name: string }[];
  expect(txnCols.find(c => c.name === "kind")).toBeUndefined();
  expect(txnCols.find(c => c.name === "category")).toBeUndefined();
  expect(itemCols.find(c => c.name === "kind")).toBeUndefined();
});

test("044: row counts unchanged across the kind-drop migration", () => {
  // Use the partial-apply harness: apply up to (but not including) 044, seed
  // data, count rows, then exec the 044 SQL and count again.
  const d = new Database(":memory:");
  applyMigrationsBefore(d, "044_");

  // Seed a minimal email so transaction_items can reference it if needed
  d.prepare(
    `INSERT INTO emails (id, received_at, from_addr, subject, raw_path)
     VALUES ('e1', '2026-01-01T00:00:00Z', 'shop@test.com', 'Receipt', 'raw/e1.eml')`
  ).run();

  // Insert two transactions (with kind set, so we verify it's readable pre-044)
  const txn1 = d.prepare(
    `INSERT INTO transactions_v2 (date, description, category, kind, derived_by)
     VALUES ('2026-01-01', 'Hardware store', 'Home', 'material', 'import')
     RETURNING id`
  ).get() as { id: number };
  const txn2 = d.prepare(
    `INSERT INTO transactions_v2 (date, description, category, kind, derived_by)
     VALUES ('2026-01-02', 'Contractor payment', NULL, 'labor', 'import')
     RETURNING id`
  ).get() as { id: number };

  // Insert a transaction_item for txn1 with kind set
  d.prepare(
    `INSERT INTO transaction_items (email_id, line_no, name, category, kind, transaction_v2_id)
     VALUES ('e1', 1, 'Lumber', 'Home', 'material', ?)`
  ).run(txn1.id);

  // Synthesize item for txn2 (no existing item)
  d.prepare(
    `INSERT INTO transaction_items (email_id, line_no, name, category, transaction_v2_id)
     VALUES (NULL, 1, 'Contractor payment', 'labor', ?)`
  ).run(txn2.id);

  // Record counts before migration 044
  const txnCountBefore = (d.prepare("SELECT COUNT(*) as n FROM transactions_v2").get() as { n: number }).n;
  const itemCountBefore = (d.prepare("SELECT COUNT(*) as n FROM transaction_items").get() as { n: number }).n;

  // Apply migration 044
  const sql044 = readFileSync(resolve(MIGRATIONS_DIR, "044_drop_kind.sql"), "utf8");
  d.exec(sql044);

  // Counts must be identical after dropping the columns
  const txnCountAfter = (d.prepare("SELECT COUNT(*) as n FROM transactions_v2").get() as { n: number }).n;
  const itemCountAfter = (d.prepare("SELECT COUNT(*) as n FROM transaction_items").get() as { n: number }).n;

  expect(txnCountAfter).toBe(txnCountBefore);
  expect(itemCountAfter).toBe(itemCountBefore);

  // Verify the dropped columns are truly gone
  const txnCols = d.prepare("PRAGMA table_info(transactions_v2)").all() as { name: string }[];
  const itemCols = d.prepare("PRAGMA table_info(transaction_items)").all() as { name: string }[];
  expect(txnCols.find(c => c.name === "kind")).toBeUndefined();
  expect(txnCols.find(c => c.name === "category")).toBeUndefined();
  expect(itemCols.find(c => c.name === "kind")).toBeUndefined();

  d.close();
});
