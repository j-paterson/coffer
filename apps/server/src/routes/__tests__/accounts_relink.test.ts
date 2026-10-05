// apps/server/src/routes/__tests__/accounts_relink.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { existsSync, unlinkSync } from "node:fs";
import { oneSided, postTransaction } from "@coffer/ledger/gatekeepers";
import accountsRoute from "../accounts";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  const acct = db.query(
    `INSERT INTO accounts (id, display_name, institution, type, mode, active, last_seen_at)
     VALUES (?, 'Rewards Card (1234)', 'Northwind Bank', 'credit', 'live', 1, ?)`,
  );
  acct.run("simplefin:old", "2026-09-01T00:00:00Z");
  acct.run("simplefin:new", "2026-10-05T00:00:00Z");
  const assert = db.query(
    `INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES (?, ?, 0, 'simplefin')`,
  );
  assert.run("simplefin:old", "2026-09-01");
  assert.run("simplefin:new", "2026-10-05");
  postTransaction(db, { date: "2026-09-10", description: "CAFE", postings: [...oneSided("simplefin:old", -20)] });
  postTransaction(db, { date: "2026-09-10", description: "CAFE", postings: [...oneSided("simplefin:new", -20)] });
});
afterEach(() => db.close());

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today: "2026-10-05" };
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/api/accounts", accountsRoute);
  return app;
}

const post = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.request("/api/accounts/relink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET lists the reconnected pair and its duplicate without changing anything", async () => {
  const res = await makeApp(db).request("/api/accounts/relink");
  const plan = (await res.json()) as any;
  expect(plan.pairs).toHaveLength(1);
  expect(plan.pairs[0].alias).toBe("simplefin:new");
  expect(plan.pairs[0].duplicates).toHaveLength(1);
  expect((db.query("SELECT COUNT(*) n FROM transactions_v2").get() as { n: number }).n).toBe(2);
});

test("POST backs up first, then merges only the reviewed pairs", async () => {
  const app = makeApp(db);
  expect((await post(app, {})).status).toBe(400);
  expect((await post(app, { aliases: ["simplefin:new"] })).status).toBe(400);
  expect((await post(app, { aliases: ["simplefin:other"], expected_removed: 1 })).status).toBe(409);
  expect((await post(app, { aliases: ["simplefin:new"], expected_removed: 2 })).status).toBe(409);
  expect((db.query("SELECT COUNT(*) n FROM transactions_v2").get() as { n: number }).n).toBe(2);

  const res = await post(app, { aliases: ["simplefin:new"], expected_removed: 1 });
  expect(res.status).toBe(200);
  const out = (await res.json()) as any;
  expect(existsSync(out.backup)).toBe(true);
  const copy = new Database(out.backup, { readonly: true });
  expect((copy.query("SELECT COUNT(*) n FROM transactions_v2").get() as { n: number }).n).toBe(2);
  copy.close();
  unlinkSync(out.backup);

  expect(out.merged).toEqual([{ canonical: "simplefin:old", alias: "simplefin:new", removed: 1 }]);
  expect((db.query("SELECT COUNT(*) n FROM transactions_v2").get() as { n: number }).n).toBe(1);
  expect(((await (await app.request("/api/accounts/relink")).json()) as any).pairs).toEqual([]);
});
