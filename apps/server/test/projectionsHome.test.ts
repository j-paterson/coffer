import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import projectionsRoute from "../src/routes/projections";
import { buildPrefill } from "../src/lib/projection/prefill";
import { createTestCtx } from "./setup";
import type { Ctx } from "../src/ctx";

function makeApp(ctx: Ctx) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/api/projections", projectionsRoute);
  return app;
}

describe("POST /api/projections/home", () => {
  test("creates a manual real-estate account that prefill detects", async () => {
    const ctx = createTestCtx();
    const app = makeApp(ctx);

    const before = buildPrefill(ctx.db);
    if (before.ok) throw new Error("expected empty DB to require home");
    expect(before.requiresHome).toBe(true);

    const res = await app.request("/api/projections/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeValue: 750_000 }),
    });
    expect(res.status).toBe(200);

    const acct = ctx.db
      .query<
        { id: string; type: string; mode: string; active: number },
        []
      >(
        `SELECT id, type, mode, active FROM accounts WHERE id = 'manual:property:home'`,
      )
      .get();
    expect(acct).toEqual({
      id: "manual:property:home",
      type: "real_estate",
      mode: "manual",
      active: 1,
    });

    const ba = ctx.db
      .query<{ expected_usd: number; source: string }, []>(
        `SELECT expected_usd, source FROM balance_assertions WHERE account_id = 'manual:property:home'`,
      )
      .get();
    expect(ba?.expected_usd).toBe(750_000);
    expect(ba?.source).toBe("manual");

    // After save, buildPrefill no longer requires a home (it now requires
    // a tax profile, which is the next gate — confirming home unblocked).
    const after = buildPrefill(ctx.db);
    if (after.ok) {
      expect(after.scenario.initialHomeValue).toBe(750_000);
    } else {
      expect(after.requiresHome).toBeFalsy();
      expect(after.requiresTaxProfile).toBe(true);
    }
  });

  test("paired mortgage creates debt account that detectMortgage finds", async () => {
    const ctx = createTestCtx();
    const app = makeApp(ctx);
    ctx.db.run(
      "INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate) VALUES (1, 0.37, 0.238, 0.238)",
    );

    const res = await app.request("/api/projections/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        homeValue: 800_000,
        mortgage: { balance: 350_000, apr: 0.0625, monthlyPayment: 2_200 },
      }),
    });
    expect(res.status).toBe(200);

    const prefill = buildPrefill(ctx.db);
    if (!prefill.ok) throw new Error("expected prefill ok");
    expect(prefill.scenario.initialHomeValue).toBe(800_000);
    expect(prefill.scenario.existingMortgage?.balance).toBe(350_000);
    expect(prefill.scenario.existingMortgage?.apr).toBe(0.0625);
    expect(prefill.scenario.existingMortgage?.monthlyPayment).toBeCloseTo(
      2_200,
      0,
    );
  });

  test("upsert: a second call with new value replaces the prior assertion same-day", async () => {
    const ctx = createTestCtx();
    const app = makeApp(ctx);

    await app.request("/api/projections/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeValue: 500_000 }),
    });
    await app.request("/api/projections/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeValue: 600_000 }),
    });

    const rows = ctx.db
      .query<{ expected_usd: number }, []>(
        `SELECT expected_usd FROM balance_assertions WHERE account_id = 'manual:property:home'`,
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.expected_usd).toBe(600_000);
  });

  test("rejects non-positive homeValue with 400", async () => {
    const app = makeApp(createTestCtx());
    const res = await app.request("/api/projections/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeValue: 0 }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects out-of-range APR with 400", async () => {
    const app = makeApp(createTestCtx());
    const res = await app.request("/api/projections/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        homeValue: 500_000,
        mortgage: { balance: 100_000, apr: 5 },
      }),
    });
    expect(res.status).toBe(400);
  });
});
