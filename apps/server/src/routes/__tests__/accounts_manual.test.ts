// apps/server/src/routes/__tests__/accounts_manual.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import accountsRoute from "../accounts";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
});
afterEach(() => db.close());

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today: "2026-06-16" };
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/api/accounts", accountsRoute);
  return app;
}

async function postJSON(app: ReturnType<typeof makeApp>, path: string, body: unknown, method = "POST") {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("create a manual asset account; it appears with its balance", async () => {
  const app = makeApp(db);
  const res = await postJSON(app, "/api/accounts", {
    display_name: "Emergency Fund",
    category: "savings",
    balance: 12000,
  });
  expect(res.status).toBe(200);
  const acct = (await res.json()) as { id: string; type: string; mode: string };
  expect(acct.type).toBe("savings");
  expect(acct.mode).toBe("manual");

  const row = db
    .prepare("SELECT expected_usd FROM balance_assertions WHERE account_id = ?")
    .get(acct.id) as { expected_usd: number };
  expect(row.expected_usd).toBe(12000);
});

test("liability category stores a negative balance", async () => {
  const app = makeApp(db);
  const res = await postJSON(app, "/api/accounts", {
    display_name: "Home Loan",
    category: "loan",
    balance: 270000,
    as_of: "2026-06-01",
  });
  const acct = (await res.json()) as { id: string; type: string };
  expect(acct.type).toBe("manual");
  const row = db
    .prepare("SELECT expected_usd, as_of FROM balance_assertions WHERE account_id = ?")
    .get(acct.id) as { expected_usd: number; as_of: string };
  expect(row.expected_usd).toBe(-270000);
  expect(row.as_of).toBe("2026-06-01");
});

test("balance update adds a second dated assertion", async () => {
  const app = makeApp(db);
  const created = await (await postJSON(app, "/api/accounts", {
    display_name: "Brokerage", category: "investment", balance: 100000, as_of: "2026-05-01",
  })).json() as { id: string };
  const res = await postJSON(app, `/api/accounts/${created.id}/balance`, {
    balance: 110000, as_of: "2026-06-01",
  });
  expect(res.status).toBe(200);
  const rows = db
    .prepare("SELECT as_of, expected_usd FROM balance_assertions WHERE account_id = ? ORDER BY as_of")
    .all(created.id) as Array<{ as_of: string; expected_usd: number }>;
  expect(rows.length).toBe(2);
  expect(rows[1].expected_usd).toBe(110000);
});

test("delete removes the account and its assertions", async () => {
  const app = makeApp(db);
  const created = await (await postJSON(app, "/api/accounts", {
    display_name: "Old Car", category: "other_asset", balance: 8000,
  })).json() as { id: string };
  const res = await app.request(`/api/accounts/${created.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(db.prepare("SELECT COUNT(*) n FROM accounts WHERE id = ?").get(created.id)).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM balance_assertions WHERE account_id = ?").get(created.id)).toEqual({ n: 0 });
});

test("balance update and delete refuse a live (provider) account", async () => {
  const app = makeApp(db);
  db.prepare(
    `INSERT INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('simplefin:live-1', 'Live Checking', 'Bank', 'checking', 'USD', 1, 'live')`,
  ).run();
  const bal = await postJSON(app, "/api/accounts/simplefin:live-1/balance", { balance: 5, as_of: "2026-06-01" });
  expect(bal.status).toBe(409);
  const del = await app.request("/api/accounts/simplefin:live-1", { method: "DELETE" });
  expect(del.status).toBe(409);
});

test("validation rejects bad input", async () => {
  const app = makeApp(db);
  expect((await postJSON(app, "/api/accounts", { display_name: "", category: "savings", balance: 1 })).status).toBe(400);
  expect((await postJSON(app, "/api/accounts", { display_name: "X", category: "nope", balance: 1 })).status).toBe(400);
  expect((await postJSON(app, "/api/accounts", { display_name: "X", category: "savings", balance: "abc" })).status).toBe(400);
});

test("active toggle refuses a live account and succeeds for a manual account", async () => {
  const app = makeApp(db);

  // Insert a live (provider) account directly.
  db.prepare(
    `INSERT INTO accounts (id, display_name, institution, type, currency, active, mode)
     VALUES ('simplefin:live-2', 'Live Savings', 'Bank', 'savings', 'USD', 1, 'live')`,
  ).run();

  // PATCH with active:0 on a live account → 409.
  const liveRes = await postJSON(app, "/api/accounts/simplefin:live-2", { active: 0 }, "PATCH");
  expect(liveRes.status).toBe(409);
  const liveBody = (await liveRes.json()) as { error: string };
  expect(liveBody.error).toBe("provider accounts cannot be archived here");

  // Create a manual account via POST.
  const created = await (await postJSON(app, "/api/accounts", {
    display_name: "Petty Cash",
    category: "checking",
    balance: 200,
  })).json() as { id: string };

  // PATCH with active:0 on a manual account → 200.
  const manualRes = await postJSON(app, `/api/accounts/${created.id}`, { active: 0 }, "PATCH");
  expect(manualRes.status).toBe(200);
  const manualBody = (await manualRes.json()) as { id: string; active: number };
  expect(manualBody.active).toBe(0);

  // Confirm the DB row is actually updated.
  const row = db
    .prepare("SELECT active FROM accounts WHERE id = ?")
    .get(created.id) as { active: number };
  expect(row.active).toBe(0);
});
