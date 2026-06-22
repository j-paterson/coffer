/**
 * Breakdown endpoint now mirrors debts: asset accounts appear as positive
 * value_usd buckets, debt accounts (credit cards, negative-balance manual
 * accounts like a mortgage) appear as NEGATIVE buckets, and each snapshot's
 * `total` is net worth (assets - debts). The web chart stacks assets above
 * and debts below a zero baseline.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import networthRoute from "../networth";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  const acct = (id: string, type: string) =>
    db
      .prepare(
        `INSERT INTO accounts (id, display_name, institution, type, currency, active, mode)
         VALUES (?, ?, 'Bank', ?, 'USD', 1, 'manual')`,
      )
      .run(id, id, type);
  acct("acct:sav", "savings");
  acct("acct:card", "credit");
  acct("acct:mortgage", "manual");
  const assert = (id: string, usd: number) =>
    db
      .prepare(
        `INSERT INTO balance_assertions (account_id, as_of, expected_usd, source, source_file)
         VALUES (?, '2026-04-01', ?, 'manual', 'feed')`,
      )
      .run(id, usd);
  assert("acct:sav", 100000);
  assert("acct:card", -2000);
  assert("acct:mortgage", -50000);
});
afterEach(() => db.close());

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today: "2026-04-30" };
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/api/networth", networthRoute);
  return app;
}

test("breakdown includes debts as negative buckets with net total", async () => {
  const app = makeApp(db);
  const res = await app.request("/api/networth/breakdown?granularity=day");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    snapshots: { as_of: string; total: number; holdings: { symbol: string; value_usd: number }[] }[];
  };
  const last = body.snapshots[body.snapshots.length - 1];

  const bySymbol = new Map(last.holdings.map((h) => [h.symbol, h.value_usd]));
  expect(bySymbol.get("acct:sav")).toBeCloseTo(100000, 2);
  expect(bySymbol.get("acct:card")).toBeCloseTo(-2000, 2);
  expect(bySymbol.get("acct:mortgage")).toBeCloseTo(-50000, 2);

  // total = net worth = assets - debts
  expect(last.total).toBeCloseTo(48000, 2);
});
