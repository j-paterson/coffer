/**
 * Tests that assert the post-migration-044 API shape:
 * - `kind` is absent from TransactionRow responses
 * - `category` is absent from TransactionRow responses for by-account endpoint
 * - PATCH /:id (kind setter) no longer exists
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import transactionsRoute from "../transactions";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";
import type { AccountTransactionsGroup } from "../../../../../packages/shared/types";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('acct:chk', 'Test Checking', 'Bank', 'checking', 'USD', 1, 'live')`,
  ).run();
  // Seed a transaction
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2026-04-01', 'Home Depot', 'ingest')`,
  ).run();
  const txnId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:chk', -100)`).run(txnId);
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'equity:unknown-counterparty', 100)`).run(txnId);
});
afterEach(() => { db.close(); });

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today: "2026-04-30" };
  app.use("*", async (c, next) => { c.set("ctx", ctx); await next(); });
  app.route("/api/transactions", transactionsRoute);
  return app;
}

test("GET /by-account — TransactionRow has no kind field", async () => {
  const app = makeApp(db);
  const res = await app.request("/api/transactions/by-account");
  expect(res.status).toBe(200);

  const groups = await res.json() as AccountTransactionsGroup[];
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    for (const txn of group.transactions) {
      expect("kind" in txn).toBe(false);
    }
  }
});

test("GET /by-account — TransactionRow has no category field (txn-level category gone)", async () => {
  const app = makeApp(db);
  const res = await app.request("/api/transactions/by-account");
  expect(res.status).toBe(200);

  const groups = await res.json() as AccountTransactionsGroup[];
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    for (const txn of group.transactions) {
      expect("category" in txn).toBe(false);
    }
  }
});

test("PATCH /:id (kind setter) route no longer exists", async () => {
  const txnId = (db.prepare(`SELECT id FROM transactions_v2 LIMIT 1`).get() as { id: number }).id;
  const app = makeApp(db);
  const res = await app.request(`/api/transactions/${txnId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "material" }),
  });
  // Route removed — Hono returns 404
  expect(res.status).toBe(404);
});
