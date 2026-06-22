import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import itemsRoute from "../items";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";

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
  app.route("/api/items", itemsRoute);
  return app;
}

test("GET /categories returns hierarchy sorted by usage", async () => {
  // Seed: insert transaction_items directly (email_id IS NULL — migration 043 allows this)
  // 3 items: Food/Coffee, 1 item: Food/Restaurant, 1 item: Travel/null
  db.prepare(
    `INSERT INTO transaction_items (name, line_total, category, subcategory, line_no)
     VALUES
       ('Starbucks', 5.00, 'Food', 'Coffee', 1),
       ('Blue Bottle', 4.50, 'Food', 'Coffee', 1),
       ('Peet''s Coffee', 4.00, 'Food', 'Coffee', 1),
       ('Burger King', 8.00, 'Food', 'Restaurant', 1),
       ('Flights', 300.00, 'Travel', NULL, 1)`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/categories");
  expect(res.status).toBe(200);

  const body = await res.json() as Array<{ category: string; subcategories: string[] }>;

  // Food has 4 items total, Travel has 1 — Food comes first
  expect(body[0].category).toBe("Food");
  expect(body[0].subcategories).toEqual(["Coffee", "Restaurant"]);

  expect(body[1].category).toBe("Travel");
  expect(body[1].subcategories).toEqual([]);

  expect(body.length).toBe(2);
});

test("GET /categories excludes items where category IS NULL", async () => {
  db.prepare(
    `INSERT INTO transaction_items (name, line_total, category, subcategory, line_no)
     VALUES
       ('Amazon', 20.00, 'Shopping', NULL, 1),
       ('Unknown', 5.00, NULL, NULL, 1)`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/categories");
  expect(res.status).toBe(200);

  const body = await res.json() as Array<{ category: string; subcategories: string[] }>;
  expect(body.length).toBe(1);
  expect(body[0].category).toBe("Shopping");
});

test("GET /categories returns empty array when no items", async () => {
  const app = makeApp(db);
  const res = await app.request("/api/items/categories");
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body).toEqual([]);
});

test("PATCH /api/items/:id sets category and subcategory atomically", async () => {
  const info = db.prepare(
    `INSERT INTO transaction_items (name, line_total, line_no) VALUES ('Starbucks', 5.00, 1)`,
  ).run();
  const id = info.lastInsertRowid;

  const app = makeApp(db);
  const res = await app.request(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "Food", subcategory: "Coffee" }),
  });
  expect(res.status).toBe(200);

  const row = db
    .prepare("SELECT category, subcategory FROM transaction_items WHERE id = ?")
    .get(id) as { category: string | null; subcategory: string | null };
  expect(row.category).toBe("Food");
  expect(row.subcategory).toBe("Coffee");
});

test("PATCH allows clearing both fields", async () => {
  const info = db.prepare(
    `INSERT INTO transaction_items (name, line_total, line_no, category, subcategory, category_source)
     VALUES ('Starbucks', 5.00, 1, 'food', 'Coffee', 'user')`,
  ).run();
  const id = info.lastInsertRowid;

  const app = makeApp(db);
  const res = await app.request(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: null, subcategory: null }),
  });
  expect(res.status).toBe(200);

  const row = db
    .prepare("SELECT category, subcategory, category_source FROM transaction_items WHERE id = ?")
    .get(id) as { category: string | null; subcategory: string | null; category_source: string | null };
  expect(row.category).toBeNull();
  expect(row.subcategory).toBeNull();
  expect(row.category_source).toBe("user");
});

test("PATCH rejects non-string category with 400", async () => {
  const info = db.prepare(
    `INSERT INTO transaction_items (name, line_total, line_no) VALUES ('Starbucks', 5.00, 1)`,
  ).run();
  const id = info.lastInsertRowid;

  const app = makeApp(db);
  const res = await app.request(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: 42 }),
  });
  expect(res.status).toBe(400);
  const body = await res.json() as { error: string };
  expect(body.error).toBe("category must be a string or null");
});

test("PATCH rejects missing body field — neither key present", async () => {
  const info = db.prepare(
    `INSERT INTO transaction_items (name, line_total, line_no) VALUES ('Starbucks', 5.00, 1)`,
  ).run();
  const id = info.lastInsertRowid;

  const app = makeApp(db);
  const res = await app.request(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ someOtherField: "value" }),
  });
  expect(res.status).toBe(400);
  const body = await res.json() as { error: string };
  expect(body.error).toBe("category or subcategory required");
});

test("PATCH propagates by merchant when keyword extractor fails on noise", async () => {
  // Three Gusto transactions, each with a different invoice number
  // embedded in the description. The "longest non-stopword token"
  // extractor picks the per-row 10-digit PPD ID — useless for matching
  // across rows. Merchant-key propagation strips PPD IDs first.
  db.prepare(
    `INSERT INTO transactions_v2 (id, date, description, derived_by) VALUES
       (1, '2026-01-01', 'Gusto Pay 248314 PPD ID: 9138864001', 'ingest'),
       (2, '2026-02-01', 'Gusto Pay 248315 PPD ID: 2453942850', 'ingest'),
       (3, '2026-03-01', 'Gusto Pay 248316 PPD ID: 7777777777', 'ingest'),
       (4, '2026-04-01', 'STARBUCKS #2384', 'ingest')`,
  ).run();
  // Synthesized items mirror migration 043: item.name == txn.description.
  db.prepare(
    `INSERT INTO transaction_items (id, name, line_total, line_no, transaction_v2_id) VALUES
       (10, 'Gusto Pay 248314 PPD ID: 9138864001', -2000, 1, 1),
       (11, 'Gusto Pay 248315 PPD ID: 2453942850', -2000, 1, 2),
       (12, 'Gusto Pay 248316 PPD ID: 7777777777', -2000, 1, 3),
       (13, 'STARBUCKS #2384', -5, 1, 4)`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/10", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "Income", subcategory: null }),
  });
  expect(res.status).toBe(200);

  const tagged = db
    .prepare("SELECT id, category, category_source FROM transaction_items WHERE id IN (10,11,12,13) ORDER BY id")
    .all() as { id: number; category: string | null; category_source: string | null }[];
  expect(tagged[0]).toEqual({ id: 10, category: "Income", category_source: "user" });
  expect(tagged[1]).toEqual({ id: 11, category: "Income", category_source: "learned" });
  expect(tagged[2]).toEqual({ id: 12, category: "Income", category_source: "learned" });
  // Starbucks is untouched.
  expect(tagged[3].category).toBeNull();
});

test("PATCH merchant propagation strips Web ID/dot-com noise across varying suffixes", async () => {
  // Two Paypal txns differ only in the Web-ID alphanumeric suffix.
  // Token extractor picks "paypalsi77" / "paypalsi99" — never matches.
  // Merchant-key normalization strips the Web ID block and matches.
  db.prepare(
    `INSERT INTO transactions_v2 (id, date, description, derived_by) VALUES
       (1, '2026-01-01', 'Paypal Inst Xfer Vrv Co Web ID: paypalsi77', 'ingest'),
       (2, '2026-02-01', 'Paypal Inst Xfer Vrv Co Web ID: paypalsi99', 'ingest')`,
  ).run();
  db.prepare(
    `INSERT INTO transaction_items (id, name, line_total, line_no, transaction_v2_id) VALUES
       (20, 'Paypal Inst Xfer Vrv Co Web ID: paypalsi77', -50, 1, 1),
       (21, 'Paypal Inst Xfer Vrv Co Web ID: paypalsi99', -75, 1, 2)`,
  ).run();

  const app = makeApp(db);
  await app.request("/api/items/20", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "Transfer", subcategory: null }),
  });
  const paypal = db
    .prepare("SELECT id, category FROM transaction_items WHERE id IN (20,21) ORDER BY id")
    .all() as { id: number; category: string | null }[];
  expect(paypal[0].category).toBe("Transfer");
  expect(paypal[1].category).toBe("Transfer");
});

test("PATCH merchant propagation skips user-categorized items", async () => {
  // Use noisy descriptions so token-based propagation can't match — that
  // way we're only testing the merchant-key path's user-guard.
  db.prepare(
    `INSERT INTO transactions_v2 (id, date, description, derived_by) VALUES
       (1, '2026-01-01', 'Gusto Pay 248314 PPD ID: 9138864001', 'ingest'),
       (2, '2026-02-01', 'Gusto Pay 248315 PPD ID: 2453942850', 'ingest')`,
  ).run();
  db.prepare(
    `INSERT INTO transaction_items (id, name, line_total, line_no, transaction_v2_id, category, category_source) VALUES
       (10, 'Gusto Pay 248314 PPD ID: 9138864001', -2000, 1, 1, NULL, NULL),
       (11, 'Gusto Pay 248315 PPD ID: 2453942850', -2000, 1, 2, 'gifts', 'user')`,
  ).run();

  const app = makeApp(db);
  await app.request("/api/items/10", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "Income", subcategory: null }),
  });

  const after = db
    .prepare("SELECT id, category, category_source FROM transaction_items WHERE id IN (10,11) ORDER BY id")
    .all() as { id: number; category: string | null; category_source: string | null }[];
  expect(after[0].category).toBe("Income");
  expect(after[0].category_source).toBe("user");
  // Item 11 was user-categorized — must not be overwritten.
  expect(after[1].category).toBe("gifts");
  expect(after[1].category_source).toBe("user");
});

test("PATCH /categories/bulk updates many items in one call", async () => {
  db.prepare(
    `INSERT INTO transaction_items (id, name, line_total, line_no, category_source) VALUES
       (1, 'Apples', 3.00, 1, NULL),
       (2, 'Bread', 4.00, 1, 'learned'),
       (3, 'Milk', 5.00, 1, NULL),
       (4, 'Untouched', 9.00, 1, NULL)`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/categories/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [1, 2, 3], category: "Food", subcategory: "Groceries" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { ok: true; items_updated: number };
  expect(body.items_updated).toBe(3);

  const rows = db
    .prepare("SELECT id, category, subcategory, category_source FROM transaction_items ORDER BY id")
    .all() as { id: number; category: string | null; subcategory: string | null; category_source: string | null }[];
  expect(rows[0]).toEqual({ id: 1, category: "Food", subcategory: "Groceries", category_source: "user" });
  expect(rows[1]).toEqual({ id: 2, category: "Food", subcategory: "Groceries", category_source: "user" });
  expect(rows[2]).toEqual({ id: 3, category: "Food", subcategory: "Groceries", category_source: "user" });
  // Item 4 was not in ids — must be untouched.
  expect(rows[3]).toEqual({ id: 4, category: null, subcategory: null, category_source: null });
});

test("PATCH /categories/bulk supports clearing both fields", async () => {
  db.prepare(
    `INSERT INTO transaction_items (id, name, line_total, line_no, category, subcategory, category_source) VALUES
       (1, 'A', 1.00, 1, 'food', 'coffee', 'learned'),
       (2, 'B', 2.00, 1, 'food', 'coffee', 'learned')`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/categories/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [1, 2], category: null, subcategory: null }),
  });
  expect(res.status).toBe(200);

  const rows = db
    .prepare("SELECT category, subcategory, category_source FROM transaction_items ORDER BY id")
    .all() as { category: string | null; subcategory: string | null; category_source: string | null }[];
  expect(rows[0]).toEqual({ category: null, subcategory: null, category_source: "user" });
  expect(rows[1]).toEqual({ category: null, subcategory: null, category_source: "user" });
});

test("PATCH /categories/bulk subcategory-only leaves category alone", async () => {
  db.prepare(
    `INSERT INTO transaction_items (id, name, line_total, line_no, category, subcategory, category_source) VALUES
       (1, 'A', 1.00, 1, 'food', NULL, 'user'),
       (2, 'B', 2.00, 1, 'food', NULL, 'user')`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/categories/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [1, 2], subcategory: "Coffee" }),
  });
  expect(res.status).toBe(200);

  const rows = db
    .prepare("SELECT category, subcategory FROM transaction_items ORDER BY id")
    .all() as { category: string | null; subcategory: string | null }[];
  expect(rows[0]).toEqual({ category: "food", subcategory: "Coffee" });
  expect(rows[1]).toEqual({ category: "food", subcategory: "Coffee" });
});

test("PATCH /categories/bulk rejects empty ids", async () => {
  const app = makeApp(db);
  const res = await app.request("/api/items/categories/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [], category: "Food" }),
  });
  expect(res.status).toBe(400);
  const body = await res.json() as { error: string };
  expect(body.error).toBe("ids must be a non-empty array");
});

test("PATCH /categories/bulk rejects non-integer ids", async () => {
  const app = makeApp(db);
  const res = await app.request("/api/items/categories/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [1, "two", 3], category: "Food" }),
  });
  expect(res.status).toBe(400);
});

test("PATCH /categories/bulk rejects when neither category nor subcategory present", async () => {
  const app = makeApp(db);
  const res = await app.request("/api/items/categories/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [1, 2] }),
  });
  expect(res.status).toBe(400);
  const body = await res.json() as { error: string };
  expect(body.error).toBe("category or subcategory required");
});

test("PATCH /categories/bulk silently skips non-existent ids", async () => {
  // Backing UPDATE just matches what's there; non-existent ids contribute 0
  // changes. This keeps clients simple — they can pass stale id sets without
  // the call failing entirely.
  db.prepare(
    `INSERT INTO transaction_items (id, name, line_total, line_no) VALUES (1, 'A', 1.00, 1)`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/categories/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [1, 999], category: "Food" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { ok: true; items_updated: number };
  expect(body.items_updated).toBe(1);
});

test("PATCH /categories/merge normalizes from + to before matching", async () => {
  // Pre-existing rows are stored canonically (lowercase). The user types
  // capitalized values into the merge dialog — those must collapse to the
  // canonical form before the WHERE match, otherwise nothing merges and we
  // silently leak a new mixed-case category.
  db.prepare(
    `INSERT INTO transaction_items (name, line_total, category, line_no)
     VALUES ('Starbucks', 5.00, 'Restaurants', 1),
            ('Cafe Mona', 4.50, 'Restaurants', 1)`,
  ).run();

  const app = makeApp(db);
  const res = await app.request("/api/items/categories/merge", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Restaurants", to: "Dining" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { from: string; to: string; items_updated: number };
  expect(body.from).toBe("Restaurants");
  expect(body.to).toBe("Dining");
  expect(body.items_updated).toBe(2);

  const rows = db
    .prepare("SELECT category FROM transaction_items ORDER BY id")
    .all() as { category: string }[];
  expect(rows.map((r) => r.category)).toEqual(["Dining", "Dining"]);
});

test("PATCH /:id/kind route no longer exists (404 from router)", async () => {
  const info = db.prepare(
    `INSERT INTO transaction_items (name, line_total, line_no) VALUES ('Lumber 2x4', 5.00, 1)`,
  ).run();
  const id = info.lastInsertRowid;

  const app = makeApp(db);
  // The /kind sub-route was removed when transaction_items.kind was dropped
  const res = await app.request(`/api/items/${id}/kind`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "material" }),
  });
  // Hono returns 404 when no matching route exists
  expect(res.status).toBe(404);
});
