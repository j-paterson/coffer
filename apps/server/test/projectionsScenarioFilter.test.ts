import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import projectionsRoute, { upsertScenarioWith } from "../src/routes/projections";
import { createTestCtx } from "./setup";
import type { Ctx } from "../src/ctx";
import type { Scenario } from "../../../packages/shared/types";

function makeApp(ctx: Ctx) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/api/projections", projectionsRoute);
  return app;
}

const BASE: Omit<Scenario, "id" | "name"> = {
  startDate: "2026-04-01",
  horizonMonths: 360,
  baselineReturnPct: 0.065,
  baselineVolPct: 0.15,
  homeAppreciationPct: 0.03,
  mc: { enabled: false, paths: 5000, seed: 42 },
  initialHomeValue: 1_000_000,
  initialPortfolioValue: 500_000,
  monthlyIncome: 15_000,
  monthlyExpense: 9_000,
  tax: {
    marginalOrdinaryRate: 0.37,
    ltcgRate: 0.238,
    qualifiedDivRate: 0.238,
    ltcgElection: false,
    ordinaryInvestmentIncomeMonthly: 0,
  },
  events: [],
};

describe("GET /api/projections", () => {
  test("?kind=heloc returns only HELOC scenarios", async () => {
    const ctx = createTestCtx();
    upsertScenarioWith(ctx.db, { ...BASE, name: "H1", projectionKind: "heloc" });
    upsertScenarioWith(ctx.db, { ...BASE, name: "R1", projectionKind: "retirement" });
    upsertScenarioWith(ctx.db, { ...BASE, name: "H2", projectionKind: "heloc" });

    const app = makeApp(ctx);
    const res = await app.request("/api/projections?kind=heloc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenarios: { name: string }[] };
    const names = body.scenarios.map((s) => s.name).sort();
    expect(names).toEqual(["H1", "H2"]);
  });

  test("no kind param returns all scenarios", async () => {
    const ctx = createTestCtx();
    upsertScenarioWith(ctx.db, { ...BASE, name: "H1", projectionKind: "heloc" });
    upsertScenarioWith(ctx.db, { ...BASE, name: "R1", projectionKind: "retirement" });

    const app = makeApp(ctx);
    const res = await app.request("/api/projections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenarios: { name: string }[] };
    expect(body.scenarios.length).toBe(2);
  });
});
