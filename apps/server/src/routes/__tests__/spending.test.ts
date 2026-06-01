import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import spendingRoute from "../spending";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";
import type { SpendingBreakdown, ItemsByCategory } from "../../../../../packages/shared/types";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  // Ensure the test account exists for postings FK
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('acct:test', 'Test Checking', 'TestBank', 'checking', 'USD', 1, 'live')`,
  ).run();
});
afterEach(() => { db.close(); });

test("migration 045 adds excluded_from_spending defaulting to 0", () => {
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by) VALUES (?, ?, ?)`,
  ).run("2026-04-01", "Test row", "ingest");
  const row = db
    .prepare(`SELECT excluded_from_spending FROM transactions_v2 LIMIT 1`)
    .get() as { excluded_from_spending: number };
  expect(row.excluded_from_spending).toBe(0);
});

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today: "2026-04-30" };
  app.use("*", async (c, next) => { c.set("ctx", ctx); await next(); });
  app.route("/api/spending", spendingRoute);
  return app;
}

/**
 * Insert a minimal spend transaction with a single item carrying the category.
 * Returns the new transaction id. Pass `excluded: true` to mark the row as
 * ignored from spending (transactions_v2.excluded_from_spending = 1).
 */
function seedSpend(
  d: Database,
  opts: { date: string; description: string; category: string; amount: number; excluded?: boolean },
): number {
  d.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by, excluded_from_spending)
     VALUES (?, ?, 'ingest', ?)`,
  ).run(opts.date, opts.description, opts.excluded ? 1 : 0);
  const txnId = (d.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  d.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:test', ?)`).run(txnId, opts.amount);
  d.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'equity:unknown-counterparty', ?)`).run(txnId, -opts.amount);
  // Synthesize an item with the category
  d.prepare(
    `INSERT INTO transaction_items (line_no, name, line_total, category, transaction_v2_id)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(opts.description, opts.amount, opts.category, txnId);
  return txnId;
}

// ─── by-category tests ────────────────────────────────────────────────────────

test("by-category: basic aggregation by item category", async () => {
  seedSpend(db, { date: "2026-04-01", description: "Grocery Store", category: "Food", amount: -50 });
  seedSpend(db, { date: "2026-04-02", description: "Pharmacy", category: "Health", amount: -30 });
  seedSpend(db, { date: "2026-04-03", description: "Coffee Shop", category: "Food", amount: -10 });

  const app = makeApp(db);
  const res = await app.request("/api/spending/by-category?from=2026-04-01&to=2026-04-30");
  expect(res.status).toBe(200);

  const body = (await res.json()) as SpendingBreakdown;
  expect(body.rows.length).toBeGreaterThanOrEqual(2);

  const food = body.rows.find(r => r.category === "Food");
  expect(food).toBeDefined();
  expect(food?.total).toBe(-60);
  expect(food?.count).toBe(2);

  const health = body.rows.find(r => r.category === "Health");
  expect(health).toBeDefined();
  expect(health?.total).toBe(-30);

  // total_spend is the sum of all category totals
  expect(body.total_spend).toBe(-90);
});

test("by-category: items with category='Transfer' are excluded", async () => {
  seedSpend(db, { date: "2026-04-07", description: "Transfer Out", category: "Transfer", amount: -500 });
  seedSpend(db, { date: "2026-04-08", description: "Coffee", category: "Food", amount: -5 });

  const app = makeApp(db);
  const res = await app.request("/api/spending/by-category?from=2026-04-01&to=2026-04-30");
  expect(res.status).toBe(200);

  const body = (await res.json()) as SpendingBreakdown;
  // Transfer category should not appear
  expect(body.rows.find(r => r.category === "Transfer")).toBeUndefined();
  // Food should still be present
  expect(body.rows.find(r => r.category === "Food")).toBeDefined();
});

test("by-category: multi-posting txns (real transfers) are excluded", async () => {
  // A transfer: two real (non-equity) postings on the same txn — excluded by the NOT EXISTS guard
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('acct:savings', 'Test Savings', 'TestBank', 'savings', 'USD', 1, 'live')`,
  ).run();

  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by)
     VALUES ('2026-04-10', 'Transfer to Savings', 'ingest')`,
  ).run();
  const transferId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  // Two real-account postings — this is what makes it a transfer
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:test', -200)`).run(transferId);
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:savings', 200)`).run(transferId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, line_total, category, transaction_v2_id)
     VALUES (1, 'Transfer to Savings', -200, 'Transfer', ?)`,
  ).run(transferId);

  // Add a normal txn so the response isn't empty
  seedSpend(db, { date: "2026-04-10", description: "Gas Station", category: "Auto", amount: -60 });

  const app = makeApp(db);
  const res = await app.request("/api/spending/by-category?from=2026-04-01&to=2026-04-30");
  expect(res.status).toBe(200);

  const body = (await res.json()) as SpendingBreakdown;
  // The multi-posting transfer must not appear
  expect(body.rows.find(r => r.category === "Transfer")).toBeUndefined();
  // Normal spend must appear
  expect(body.rows.find(r => r.category === "Auto")).toBeDefined();
});

test("by-category: date range filtering excludes out-of-range txns", async () => {
  seedSpend(db, { date: "2026-03-15", description: "March Groceries", category: "Food", amount: -80 });
  seedSpend(db, { date: "2026-04-15", description: "April Groceries", category: "Food", amount: -50 });

  const app = makeApp(db);
  // Only request April
  const res = await app.request("/api/spending/by-category?from=2026-04-01&to=2026-04-30");
  expect(res.status).toBe(200);

  const body = (await res.json()) as SpendingBreakdown;
  const food = body.rows.find(r => r.category === "Food");
  // Only the April txn should be included
  expect(food?.total).toBe(-50);
  expect(food?.count).toBe(1);
});

test("by-category: top_merchants populated per category", async () => {
  seedSpend(db, { date: "2026-04-01", description: "Whole Foods", category: "Food", amount: -60 });
  seedSpend(db, { date: "2026-04-02", description: "Trader Joe's", category: "Food", amount: -40 });
  seedSpend(db, { date: "2026-04-03", description: "Home Depot", category: "Hardware", amount: -200 });

  const app = makeApp(db);
  const res = await app.request("/api/spending/by-category?from=2026-04-01&to=2026-04-30");
  expect(res.status).toBe(200);

  const body = (await res.json()) as SpendingBreakdown;
  const food = body.rows.find(r => r.category === "Food");
  expect(food).toBeDefined();
  expect(food!.top_merchants.length).toBe(2);
  // Whole Foods has larger absolute spend so it appears first
  expect(food!.top_merchants[0].description).toBe("Whole Foods");

  const hardware = body.rows.find(r => r.category === "Hardware");
  expect(hardware!.top_merchants.length).toBe(1);
  expect(hardware!.top_merchants[0].description).toBe("Home Depot");
});

// ─── items-by-category test ───────────────────────────────────────────────────

test("items-by-category: returns subcategory buckets for a parent category", async () => {
  // Insert txn with items having subcategories under 'Food'
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by)
     VALUES ('2026-04-01', 'Amazon Fresh', 'ingest')`,
  ).run();
  const txnId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:test', -40)`).run(txnId);
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'equity:unknown-counterparty', 40)`).run(txnId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, line_total, category, subcategory, transaction_v2_id)
     VALUES (1, 'Apples', -10, 'Food', 'Produce', ?)`,
  ).run(txnId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, line_total, category, subcategory, transaction_v2_id)
     VALUES (2, 'Bread', -5, 'Food', 'Bakery', ?)`,
  ).run(txnId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, line_total, category, subcategory, transaction_v2_id)
     VALUES (3, 'Mystery Item', -8, 'Food', NULL, ?)`,
  ).run(txnId);

  const app = makeApp(db);
  const res = await app.request("/api/spending/items-by-category?parent=Food");
  expect(res.status).toBe(200);

  const body = (await res.json()) as ItemsByCategory;
  expect(body.parent).toBe("Food");
  expect(body.total_items).toBe(3);
  // 'classified' counts items WITH a subcategory
  expect(body.classified).toBe(2);
  expect(body.unclassified).toBe(1);

  // subcategories should contain Produce and Bakery
  const produce = body.subcategories.find(s => s.category === "Produce");
  expect(produce?.total).toBe(-10);
  const bakery = body.subcategories.find(s => s.category === "Bakery");
  expect(bakery?.total).toBe(-5);
});

// ─── ignore-in-spending tests ────────────────────────────────────────────────

test("by-category: excluded rows are dropped from the breakdown", async () => {
  seedSpend(db, { date: "2026-04-10", description: "Cafe", category: "Food", amount: -10 });
  seedSpend(db, { date: "2026-04-11", description: "Refund test", category: "Food", amount: -25, excluded: true });
  const app = makeApp(db);
  const res = await app.request("/api/spending/by-category?from=2026-04-01&to=2026-04-30");
  const body = (await res.json()) as SpendingBreakdown;
  const food = body.rows.find((r) => r.category === "Food")!;
  expect(food.count).toBe(1);
  expect(food.total).toBe(-10);
});

test("transactions: excluded rows are omitted by default", async () => {
  seedSpend(db, { date: "2026-04-10", description: "Cafe", category: "Food", amount: -10 });
  seedSpend(db, { date: "2026-04-11", description: "Skip me", category: "Food", amount: -25, excluded: true });
  const app = makeApp(db);
  const res = await app.request("/api/spending/transactions?category=Food&from=2026-04-01&to=2026-04-30");
  const body = (await res.json()) as { rows: { description: string }[]; excluded_count: number };
  expect(body.rows.length).toBe(1);
  expect(body.rows[0].description).toBe("Cafe");
  expect(body.excluded_count).toBe(1);
});

test("transactions: include_excluded=1 returns ignored rows with the flag set", async () => {
  seedSpend(db, { date: "2026-04-10", description: "Cafe", category: "Food", amount: -10 });
  seedSpend(db, { date: "2026-04-11", description: "Skip me", category: "Food", amount: -25, excluded: true });
  const app = makeApp(db);
  const res = await app.request("/api/spending/transactions?category=Food&from=2026-04-01&to=2026-04-30&include_excluded=1");
  const body = (await res.json()) as {
    rows: { description: string; excluded_from_spending: boolean }[];
    excluded_count: number;
  };
  expect(body.rows.length).toBe(2);
  const skipped = body.rows.find((r) => r.description === "Skip me")!;
  expect(skipped.excluded_from_spending).toBe(true);
  expect(body.excluded_count).toBe(1);
});

test("items-by-category: excluded rows' items are dropped", async () => {
  // seedSpend creates one item per txn; the visible row keeps its item,
  // the hidden row's item is dropped via the excluded-from-spending guard.
  seedSpend(db, { date: "2026-04-10", description: "Cafe", category: "Food", amount: -10 });
  seedSpend(db, { date: "2026-04-11", description: "Skip", category: "Food", amount: -25, excluded: true });
  const app = makeApp(db);
  const res = await app.request("/api/spending/items-by-category?parent=Food&from=2026-04-01&to=2026-04-30");
  const body = (await res.json()) as ItemsByCategory;
  expect(body.total_items).toBe(1);
});

test("PATCH /transactions/:id/exclude flips the column", async () => {
  const id = seedSpend(db, { date: "2026-04-10", description: "Cafe", category: "Food", amount: -10 });
  const app = makeApp(db);
  const res = await app.request(`/api/spending/transactions/${id}/exclude`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ excluded: true }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: true; excluded: boolean };
  expect(body).toEqual({ ok: true, excluded: true });
  const stored = db
    .prepare(`SELECT excluded_from_spending FROM transactions_v2 WHERE id = ?`)
    .get(id) as { excluded_from_spending: number };
  expect(stored.excluded_from_spending).toBe(1);
});

test("PATCH is idempotent (no-op flip is still 200 ok)", async () => {
  const id = seedSpend(db, { date: "2026-04-10", description: "Cafe", category: "Food", amount: -10, excluded: true });
  const app = makeApp(db);
  const res = await app.request(`/api/spending/transactions/${id}/exclude`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ excluded: true }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; excluded: boolean };
  expect(body).toEqual({ ok: true, excluded: true });
});

test("PATCH on missing id returns 404", async () => {
  const app = makeApp(db);
  const res = await app.request(`/api/spending/transactions/9999999/exclude`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ excluded: true }),
  });
  expect(res.status).toBe(404);
});

// ─── line_total NULL → unit_price fallback ───────────────────────────────────
//
// Some receipt items only have `unit_price` (and optional `quantity`) populated;
// `line_total` is NULL. The aggregation must fall back to `unit_price * quantity`
// so those categories don't render as $0 in the donut.

test("by-category: items with NULL line_total fall back to unit_price * quantity", async () => {
  // Single-item txn with line_total=NULL, unit_price=15, quantity=2 → expect -30 in 'Hardware'.
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by)
     VALUES ('2026-04-05', 'Home Depot', 'ingest')`,
  ).run();
  const txnId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:test', -30)`).run(txnId);
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'equity:unknown-counterparty', 30)`).run(txnId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, unit_price, quantity, line_total, category, transaction_v2_id)
     VALUES (1, 'Bolts', -15, 2, NULL, 'Hardware', ?)`,
  ).run(txnId);

  const app = makeApp(db);
  const res = await app.request("/api/spending/by-category?from=2026-04-01&to=2026-04-30");
  expect(res.status).toBe(200);
  const body = (await res.json()) as SpendingBreakdown;
  const hardware = body.rows.find((r) => r.category === "Hardware");
  expect(hardware).toBeDefined();
  expect(hardware!.total).toBe(-30);
});

test("items-by-category: subcategory bucket with NULL line_total falls back to unit_price * quantity", async () => {
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by)
     VALUES ('2026-04-05', 'Amazon', 'ingest')`,
  ).run();
  const txnId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:test', -50)`).run(txnId);
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'equity:unknown-counterparty', 50)`).run(txnId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, unit_price, quantity, line_total, category, subcategory, transaction_v2_id)
     VALUES (1, 'Drill', -50, 1, NULL, 'Hardware', 'Power Tools', ?)`,
  ).run(txnId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, unit_price, quantity, line_total, category, subcategory, transaction_v2_id)
     VALUES (2, 'Battery', -10, 3, NULL, 'Hardware', 'Power Tools', ?)`,
  ).run(txnId);

  const app = makeApp(db);
  const res = await app.request("/api/spending/items-by-category?parent=Hardware&from=2026-04-01&to=2026-04-30");
  expect(res.status).toBe(200);
  const body = (await res.json()) as ItemsByCategory;
  const tools = body.subcategories.find((s) => s.category === "Power Tools");
  expect(tools).toBeDefined();
  // -50*1 + -10*3 = -80
  expect(tools!.total).toBe(-80);
});

test("PATCH with non-JSON body returns 400 with structured error", async () => {
  const id = seedSpend(db, { date: "2026-04-10", description: "Cafe", category: "Food", amount: -10 });
  const app = makeApp(db);
  const res = await app.request(`/api/spending/transactions/${id}/exclude`, {
    method: "PATCH",
    headers: { "content-type": "text/plain" },
    body: "not-json",
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body).toEqual({ error: "request body must be JSON" });
});
