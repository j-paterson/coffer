import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import goalsRoute, { decorateGoal, type GoalRow } from "../goals";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";
import type { Goal, GoalsListResponse } from "../../../../../packages/shared/types";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
});
afterEach(() => { db.close(); });

const TODAY = "2026-05-05";

function makeApp(d: Database, today = TODAY) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today };
  app.use("*", async (c, next) => { c.set("ctx", ctx); await next(); });
  app.route("/api/goals", goalsRoute);
  return app;
}

function row(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: 1,
    name: "Test",
    target_amount: 1000,
    allocated_amount: 0,
    due_date: null,
    created_at: "2026-05-05 00:00:00",
    completed_at: null,
    ...overrides,
  };
}

describe("decorateGoal", () => {
  test("pct_funded is allocated/target * 100, capped at 100", () => {
    expect(decorateGoal(row({ allocated_amount: 250, target_amount: 1000 }), TODAY).pct_funded).toBe(25);
    expect(decorateGoal(row({ allocated_amount: 1500, target_amount: 1000 }), TODAY).pct_funded).toBe(100);
  });

  test("is_funded true when allocated >= target", () => {
    expect(decorateGoal(row({ allocated_amount: 1000, target_amount: 1000 }), TODAY).is_funded).toBe(true);
    expect(decorateGoal(row({ allocated_amount: 999.99, target_amount: 1000 }), TODAY).is_funded).toBe(false);
  });

  test("monthly_pace omitted when no due_date", () => {
    expect(decorateGoal(row({ due_date: null }), TODAY).monthly_pace).toBeUndefined();
  });

  test("monthly_pace omitted when already funded", () => {
    expect(
      decorateGoal(row({ allocated_amount: 1000, target_amount: 1000, due_date: "2026-12-01" }), TODAY).monthly_pace,
    ).toBeUndefined();
  });

  test("monthly_pace uses month boundaries for far-future date", () => {
    // 2026-05-05 → 2026-10-01 is 5 calendar months. Need $1000, denom 5 = $200/mo.
    const g = decorateGoal(row({ allocated_amount: 0, target_amount: 1000, due_date: "2026-10-01" }), TODAY);
    expect(g.monthly_pace).toBe(200);
  });

  test("monthly_pace clamps denominator to 1 for current-month due date", () => {
    // due in same month → divide-by-zero risk → denominator clamped to 1.
    const g = decorateGoal(row({ allocated_amount: 0, target_amount: 500, due_date: "2026-05-30" }), TODAY);
    expect(g.monthly_pace).toBe(500);
  });

  test("monthly_pace clamps denominator to 1 for past due date", () => {
    const g = decorateGoal(row({ allocated_amount: 0, target_amount: 500, due_date: "2026-01-01" }), TODAY);
    expect(g.monthly_pace).toBe(500);
  });
});

describe("POST /api/goals", () => {
  test("creates a goal with valid body", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Property tax", target_amount: 13000, due_date: "2026-10-01" }),
    });
    expect(res.status).toBe(201);
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.id).toBeGreaterThan(0);
    expect(goal.name).toBe("Property tax");
    expect(goal.target_amount).toBe(13000);
    expect(goal.allocated_amount).toBe(0);
    expect(goal.due_date).toBe("2026-10-01");
    expect(goal.pct_funded).toBe(0);
    expect(goal.is_funded).toBe(false);
  });

  test("creates a goal without due_date", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "AC repair", target_amount: 10000 }),
    });
    expect(res.status).toBe(201);
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.due_date).toBeNull();
    expect(goal.monthly_pace).toBeUndefined();
  });

  test("rejects missing or empty name", async () => {
    const app = makeApp(db);
    const r1 = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_amount: 100 }),
    });
    expect(r1.status).toBe(400);
    const r2 = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  ", target_amount: 100 }),
    });
    expect(r2.status).toBe(400);
  });

  test("rejects non-positive target_amount", async () => {
    const app = makeApp(db);
    for (const target of [0, -10, "abc"]) {
      const res = await app.request("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", target_amount: target }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("rejects malformed due_date", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", target_amount: 100, due_date: "10/01/2026" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/goals", () => {
  test("returns active goals only by default", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 100)`).run();
    db.prepare(`INSERT INTO goals (name, target_amount, completed_at) VALUES ('B', 200, '2026-04-01 00:00:00')`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals");
    expect(res.status).toBe(200);
    const { goals } = (await res.json()) as GoalsListResponse;
    expect(goals.map((g) => g.name)).toEqual(["A"]);
  });

  test("?include_archived=1 returns both", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 100)`).run();
    db.prepare(`INSERT INTO goals (name, target_amount, completed_at) VALUES ('B', 200, '2026-04-01 00:00:00')`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals?include_archived=1");
    const { goals } = (await res.json()) as GoalsListResponse;
    expect(goals.map((g) => g.name).sort()).toEqual(["A", "B"]);
  });

  test("response is empty array when no goals exist", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals");
    const body = (await res.json()) as GoalsListResponse;
    expect(body.goals).toEqual([]);
  });

  test("each goal has computed pct_funded and is_funded", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount, allocated_amount) VALUES ('Half', 1000, 500)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals");
    const { goals } = (await res.json()) as GoalsListResponse;
    expect(goals[0].pct_funded).toBe(50);
    expect(goals[0].is_funded).toBe(false);
  });
});

describe("PATCH /api/goals/:id", () => {
  test("updates name only", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('Old', 100)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New" }),
    });
    expect(res.status).toBe(200);
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.name).toBe("New");
    expect(goal.target_amount).toBe(100);
  });

  test("updates target_amount", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 100)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_amount: 250 }),
    });
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.target_amount).toBe(250);
  });

  test("clears due_date when explicitly set to null", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount, due_date) VALUES ('A', 100, '2026-12-01')`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ due_date: null }),
    });
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.due_date).toBeNull();
  });

  test("rejects target_amount <= 0", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 100)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_amount: 0 }),
    });
    expect(res.status).toBe(400);
  });

  test("404 on unknown id", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals/999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/goals/:id/allocate", () => {
  test("positive amount adds to allocated_amount", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 1000)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 250 }),
    });
    expect(res.status).toBe(200);
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.allocated_amount).toBe(250);
  });

  test("negative amount draws down", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount, allocated_amount) VALUES ('A', 1000, 500)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: -200 }),
    });
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.allocated_amount).toBe(300);
  });

  test("clamps allocated_amount at 0 when drawdown exceeds balance", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount, allocated_amount) VALUES ('A', 1000, 100)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: -500 }),
    });
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.allocated_amount).toBe(0);
  });

  test("rejects non-numeric amount", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 1000)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "foo" }),
    });
    expect(res.status).toBe(400);
  });

  test("404 on unknown id", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals/999/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/goals/:id/archive", () => {
  test("sets completed_at and removes from default GET", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 100)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1/archive", { method: "POST" });
    expect(res.status).toBe(200);
    const { goal } = (await res.json()) as { goal: Goal };
    expect(goal.completed_at).not.toBeNull();

    const list = await app.request("/api/goals");
    const { goals } = (await list.json()) as GoalsListResponse;
    expect(goals).toEqual([]);
  });

  test("archived goals appear with ?include_archived=1", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 100)`).run();
    const app = makeApp(db);
    await app.request("/api/goals/1/archive", { method: "POST" });
    const list = await app.request("/api/goals?include_archived=1");
    const { goals } = (await list.json()) as GoalsListResponse;
    expect(goals).toHaveLength(1);
    expect(goals[0].completed_at).not.toBeNull();
  });

  test("404 on unknown id", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals/999/archive", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/goals/:id", () => {
  test("removes the row", async () => {
    db.prepare(`INSERT INTO goals (name, target_amount) VALUES ('A', 100)`).run();
    const app = makeApp(db);
    const res = await app.request("/api/goals/1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const list = await app.request("/api/goals?include_archived=1");
    const { goals } = (await list.json()) as GoalsListResponse;
    expect(goals).toEqual([]);
  });

  test("404 on unknown id", async () => {
    const app = makeApp(db);
    const res = await app.request("/api/goals/999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
