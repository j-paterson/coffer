/**
 * Regression tests for cashflow required-spend queries.
 *
 * The key regression (introduced in Task 8 commit 8da8e69): joining
 * transaction_items directly multiplies p.amount by item count, inflating
 * required-spend. A $200 grocery run with 8 items would count as $1,600.
 * The fix uses EXISTS for the scalar query and sums i.line_total for the
 * breakdown query.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import cashflowRoute from "../cashflow";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";
import type { CashflowResponse } from "../../../../../packages/shared/types";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('acct:chk', 'Test Checking', 'Bank', 'checking', 'USD', 1, 'live')`,
  ).run();
  // cashflow_settings row is seeded by migration 015 (id=1, pay_frequency='semimonthly')
});
afterEach(() => { db.close(); });

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  // Use a fixed "today" so date('now', '-90 days') is deterministic
  const ctx: Ctx = { db: d, today: "2026-04-30" };
  app.use("*", async (c, next) => { c.set("ctx", ctx); await next(); });
  app.route("/api/cashflow", cashflowRoute);
  return app;
}

/**
 * Seed a spend transaction.
 * - posting amount: opts.amount (negative, e.g. -200)
 * - items: array of { category, line_total }
 * All items are attached to the same transaction.
 * Returns the transaction id.
 */
function seedTxn(
  d: Database,
  opts: {
    date: string;
    description: string;
    postingAmount: number;
    items: Array<{ category: string; line_total: number }>;
  },
): number {
  d.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by) VALUES (?, ?, 'ingest')`,
  ).run(opts.date, opts.description);
  const txnId = (d.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  // Real posting (spend)
  d.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:chk', ?)`).run(txnId, opts.postingAmount);
  // Equity counterpart
  d.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'equity:unknown-counterparty', ?)`).run(txnId, -opts.postingAmount);
  // Items
  for (let lineNo = 0; lineNo < opts.items.length; lineNo++) {
    const item = opts.items[lineNo];
    d.prepare(
      `INSERT INTO transaction_items (line_no, name, line_total, category, transaction_v2_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(lineNo + 1, `item-${lineNo + 1}`, item.line_total, item.category, txnId);
  }
  return txnId;
}

// ─── Regression: multi-item txn must not inflate required-spend scalar ────────

test("REGRESSION: 8-item $200 grocery txn counts as $200, not $1600", async () => {
  // Seed one txn: posting amount -200, 8 items each with line_total -25
  // (8 × $25 = $200 total). The buggy query would sum p.amount 8 times → $1600.
  const items = Array.from({ length: 8 }, () => ({ category: "Groceries", line_total: -25 }));
  seedTxn(db, {
    date: "2026-04-01",
    description: "Grocery Store",
    postingAmount: -200,
    items,
  });

  const app = makeApp(db);
  const res = await app.request("/api/cashflow");
  expect(res.status).toBe(200);

  const body = (await res.json()) as CashflowResponse;

  // detected_monthly_required is requiredRow.total / 3.
  // Over 90 days (≈3 months), a single $200 txn → $200/3 ≈ 66.67.
  // The buggy result would be $1600/3 ≈ 533.33.
  expect(body.detected_monthly_required).toBeCloseTo(200 / 3, 1);
  // Definitely not the inflated value
  expect(body.detected_monthly_required).toBeLessThan(100);
});

// ─── Breakdown query: item line_totals, not posting amount ────────────────────

test("breakdown: multi-item txn attributes line_totals per category", async () => {
  // $200 posting; 6 Grocery items ($150 total) + 2 Hardware items ($50 total)
  seedTxn(db, {
    date: "2026-04-01",
    description: "Costco",
    postingAmount: -200,
    items: [
      ...Array.from({ length: 6 }, () => ({ category: "Groceries", line_total: -25 })),
      ...Array.from({ length: 2 }, () => ({ category: "Gas", line_total: -25 })),
    ],
  });

  const app = makeApp(db);
  const res = await app.request("/api/cashflow");
  expect(res.status).toBe(200);

  const body = (await res.json()) as CashflowResponse;
  const grocery = body.required_breakdown.find(r => r.category === "Groceries");
  const gas = body.required_breakdown.find(r => r.category === "Gas");

  // Groceries: 6 × $25 = $150 over 90 days → $50/month
  expect(grocery).toBeDefined();
  expect(grocery!.monthly_avg).toBeCloseTo(150 / 3, 1);

  // Gas: 2 × $25 = $50 over 90 days → $16.67/month
  expect(gas).toBeDefined();
  expect(gas!.monthly_avg).toBeCloseTo(50 / 3, 1);
});

// ─── Date range: txns outside the 90-day window are excluded ─────────────────

test("required-spend: old txns outside 90-day window are excluded", async () => {
  // Txn from 6 months ago — should be outside the 90-day window
  seedTxn(db, {
    date: "2025-10-01",
    description: "Old Groceries",
    postingAmount: -300,
    items: [{ category: "Groceries", line_total: -300 }],
  });

  // Recent txn within window
  seedTxn(db, {
    date: "2026-04-01",
    description: "Recent Groceries",
    postingAmount: -60,
    items: [{ category: "Groceries", line_total: -60 }],
  });

  const app = makeApp(db);
  const res = await app.request("/api/cashflow");
  expect(res.status).toBe(200);

  const body = (await res.json()) as CashflowResponse;
  // Only the $60 recent txn should count
  expect(body.detected_monthly_required).toBeCloseTo(60 / 3, 1);
});

// ─── cointracker txns excluded from both queries ──────────────────────────────

test("required-spend: cointracker txns are excluded", async () => {
  // cointracker txn — should be excluded
  db.prepare(
    `INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2026-04-02', 'BTC Buy', 'cointracker')`,
  ).run();
  const coinId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'acct:chk', -500)`).run(coinId);
  db.prepare(`INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'equity:unknown-counterparty', 500)`).run(coinId);
  db.prepare(
    `INSERT INTO transaction_items (line_no, name, line_total, category, transaction_v2_id) VALUES (1, 'BTC', -500, 'Groceries', ?)`,
  ).run(coinId);

  // Normal txn
  seedTxn(db, {
    date: "2026-04-01",
    description: "Real Groceries",
    postingAmount: -100,
    items: [{ category: "Groceries", line_total: -100 }],
  });

  const app = makeApp(db);
  const res = await app.request("/api/cashflow");
  expect(res.status).toBe(200);

  const body = (await res.json()) as CashflowResponse;
  // Only the $100 normal txn should count
  expect(body.detected_monthly_required).toBeCloseTo(100 / 3, 1);
  expect(body.detected_monthly_required).toBeLessThan(200);
});

// ─── Non-required categories don't pollute required-spend ────────────────────

test("required-spend: non-required category txns are not counted", async () => {
  // "Dining" is not in REQUIRED_CATEGORIES
  seedTxn(db, {
    date: "2026-04-01",
    description: "Restaurant",
    postingAmount: -80,
    items: [{ category: "Dining", line_total: -80 }],
  });

  seedTxn(db, {
    date: "2026-04-01",
    description: "Electric Bill",
    postingAmount: -120,
    items: [{ category: "Utilities", line_total: -120 }],
  });

  const app = makeApp(db);
  const res = await app.request("/api/cashflow");
  expect(res.status).toBe(200);

  const body = (await res.json()) as CashflowResponse;
  // Only Utilities ($120) should count, not Dining ($80)
  expect(body.detected_monthly_required).toBeCloseTo(120 / 3, 1);
});
