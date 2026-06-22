import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import bundlesRoute from "../bundles";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";
import { BUNDLE_TEMPLATES } from "../../lib/bundle_templates";
import type { BundleDetail, CategoryOption, TransactionRow } from "../../../../../packages/shared/types";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
});
afterEach(() => { db.close(); });

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today: "2026-04-30" };
  app.use("*", async (c, next) => { c.set("ctx", ctx); await next(); });
  app.route("/api/bundles", bundlesRoute);
  return app;
}

test("GET /api/bundles/:id includes category_options", async () => {
  // Insert a renovation bundle directly with the expected category_options JSON
  const renovationOptions = JSON.stringify(BUNDLE_TEMPLATES.renovation);
  db.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count, category_options)
     VALUES ('reno-test', 'kitchen-reno', 'Kitchen Reno', 'renovation', '2026-01-01', '2026-03-31', 0, 0, ?)`,
  ).run(renovationOptions);

  const app = makeApp(db);
  const res = await app.request("/api/bundles/reno-test");
  expect(res.status).toBe(200);

  const body = await res.json() as { category_options: CategoryOption[] };
  expect(Array.isArray(body.category_options)).toBe(true);
  // renovation template has 4 top-level categories
  expect(body.category_options.length).toBe(4);
  expect(body.category_options).toEqual(BUNDLE_TEMPLATES.renovation);
});

test("PATCH /api/bundles/:id/category_options replaces the array", async () => {
  // Seed a bundle
  db.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('trip-test', 'paris-trip', 'Paris Trip', 'trip', '2026-02-01', '2026-02-14', 0, 0)`,
  ).run();

  const app = makeApp(db);

  const newOptions: CategoryOption[] = [
    { category: "Custom", subcategories: ["A", "B"] },
  ];

  const patchRes = await app.request("/api/bundles/trip-test/category_options", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category_options: newOptions }),
  });
  expect(patchRes.status).toBe(200);
  const patchBody = await patchRes.json() as { ok: boolean; category_options: CategoryOption[] };
  expect(patchBody.ok).toBe(true);
  expect(patchBody.category_options).toEqual(newOptions);

  // GET and verify it round-trips
  const getRes = await app.request("/api/bundles/trip-test");
  expect(getRes.status).toBe(200);
  const getBody = await getRes.json() as { category_options: CategoryOption[] };
  expect(getBody.category_options).toEqual(newOptions);
});

test("PATCH validates shape — non-array body returns 400", async () => {
  db.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('proj-test', 'my-project', 'My Project', 'project', '2026-03-01', '2026-03-31', 0, 0)`,
  ).run();

  const app = makeApp(db);

  const res = await app.request("/api/bundles/proj-test/category_options", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category_options: "not-an-array" }),
  });
  expect(res.status).toBe(400);
  const body = await res.json() as { error: string };
  expect(body.error).toContain("array");
});

test("POST /api/bundles applies type template to new bundle", async () => {
  const app = makeApp(db);

  const postRes = await app.request("/api/bundles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Italy 2026", type: "trip" }),
  });
  expect(postRes.status).toBe(201);
  const created = await postRes.json() as { id: string };
  expect(created.id).toBeTruthy();

  // GET the new bundle and verify category_options match the trip template
  const getRes = await app.request(`/api/bundles/${created.id}`);
  expect(getRes.status).toBe(200);
  const body = await getRes.json() as { category_options: CategoryOption[] };
  expect(body.category_options).toEqual(BUNDLE_TEMPLATES.trip);
});

test("GET /api/bundles/:id — transactions have no kind or NULL category placeholder", async () => {
  // Seed a bundle with a transaction
  db.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('reno-shape', 'shape-test', 'Shape Test', 'renovation', '2026-01-01', '2026-03-31', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('acct:chk', 'Checking', 'Bank', 'checking', 'USD', 1, 'live')`,
  ).run();
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by, trip_id)
     VALUES ('2026-01-15', 'Lumber', 'ingest', 'reno-shape')`,
  ).run();
  const txnId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:chk', -200)`).run(txnId);

  const app = makeApp(db);
  const res = await app.request("/api/bundles/reno-shape");
  expect(res.status).toBe(200);

  const body = await res.json() as BundleDetail;
  expect(body.transactions.length).toBeGreaterThan(0);
  for (const txn of body.transactions) {
    // kind should be absent from response shape
    expect("kind" in txn).toBe(false);
    // category should be absent from response shape (it was NULL placeholder before cleanup)
    expect("category" in txn).toBe(false);
  }
});

test("GET /api/bundles/:id/search — transactions have no kind or NULL category placeholder", async () => {
  db.prepare(
    `INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
     VALUES ('reno-search', 'search-test', 'Search Test', 'renovation', '2026-01-01', '2026-03-31', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('acct:chk', 'Checking', 'Bank', 'checking', 'USD', 1, 'live')`,
  ).run();
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by, trip_id)
     VALUES ('2026-01-20', 'Paint Supplies', 'ingest', 'reno-search')`,
  ).run();
  const txnId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:chk', -50)`).run(txnId);

  const app = makeApp(db);
  const res = await app.request("/api/bundles/reno-search/search?q=Paint");
  expect(res.status).toBe(200);

  const rows = await res.json() as TransactionRow[];
  expect(rows.length).toBeGreaterThan(0);
  for (const txn of rows) {
    expect("kind" in txn).toBe(false);
    expect("category" in txn).toBe(false);
  }
});
