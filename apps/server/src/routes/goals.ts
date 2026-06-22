import { Hono } from "hono";
import type { Ctx } from "../ctx";
import type { Goal } from "../../../../packages/shared/types";

export interface GoalRow {
  id: number;
  name: string;
  target_amount: number;
  allocated_amount: number;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
}

function monthsBetween(today: string, due: string): number {
  // ISO 'YYYY-MM-DD' → integer month delta (due - today). Negative or
  // zero means due is in the current month or already past.
  const [ty, tm] = today.split("-").map(Number);
  const [dy, dm] = due.split("-").map(Number);
  return (dy - ty) * 12 + (dm - tm);
}

export function decorateGoal(r: GoalRow, today: string): Goal {
  const pct_funded = Math.min((r.allocated_amount / r.target_amount) * 100, 100);
  const is_funded = r.allocated_amount >= r.target_amount;
  let monthly_pace: number | undefined;
  if (r.due_date && !is_funded) {
    const denom = Math.max(monthsBetween(today, r.due_date), 1);
    monthly_pace = (r.target_amount - r.allocated_amount) / denom;
  }
  return {
    id: r.id,
    name: r.name,
    target_amount: r.target_amount,
    allocated_amount: r.allocated_amount,
    due_date: r.due_date,
    created_at: r.created_at,
    completed_at: r.completed_at,
    pct_funded,
    is_funded,
    monthly_pace,
  };
}

const route = new Hono();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function badName(name: unknown): string | null {
  if (typeof name !== "string" || name.trim().length === 0) {
    return "name is required";
  }
  return null;
}

function badTarget(t: unknown): string | null {
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    return "target_amount must be a positive number";
  }
  return null;
}

function badDueDate(d: unknown): string | null {
  if (d === null || d === undefined) return null;
  if (typeof d !== "string" || !ISO_DATE.test(d)) {
    return "due_date must be ISO YYYY-MM-DD or null";
  }
  return null;
}

route.get("/", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const includeArchived = c.req.query("include_archived") === "1";
  const where = includeArchived ? "" : "WHERE completed_at IS NULL";
  const rows = ctx.db
    .prepare(
      `SELECT id, name, target_amount, allocated_amount, due_date, created_at, completed_at
       FROM goals ${where}
       ORDER BY completed_at IS NULL DESC, created_at DESC, id DESC`,
    )
    .all() as GoalRow[];
  return c.json({ goals: rows.map((r) => decorateGoal(r, ctx.today)) });
});

route.post("/", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const body = await c.req.json<{
    name?: string;
    target_amount?: number;
    due_date?: string | null;
  }>();
  const err = badName(body.name) ?? badTarget(body.target_amount) ?? badDueDate(body.due_date);
  if (err) return c.json({ error: err }, 400);

  const result = ctx.db
    .prepare(
      `INSERT INTO goals (name, target_amount, due_date)
       VALUES (?, ?, ?)`,
    )
    .run(body.name!.trim(), body.target_amount!, body.due_date ?? null);

  const inserted = ctx.db
    .prepare(
      `SELECT id, name, target_amount, allocated_amount, due_date, created_at, completed_at
       FROM goals WHERE id = ?`,
    )
    .get(Number(result.lastInsertRowid)) as GoalRow;

  return c.json({ goal: decorateGoal(inserted, ctx.today) }, 201);
});

route.patch("/:id", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    name?: string;
    target_amount?: number;
    due_date?: string | null;
  }>();

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.name !== undefined) {
    const err = badName(body.name);
    if (err) return c.json({ error: err }, 400);
    sets.push("name = ?");
    params.push(body.name.trim());
  }
  if (body.target_amount !== undefined) {
    const err = badTarget(body.target_amount);
    if (err) return c.json({ error: err }, 400);
    sets.push("target_amount = ?");
    params.push(body.target_amount);
  }
  if (body.due_date !== undefined) {
    const err = badDueDate(body.due_date);
    if (err) return c.json({ error: err }, 400);
    sets.push("due_date = ?");
    params.push(body.due_date);
  }

  if (sets.length === 0) return c.json({ error: "no fields to update" }, 400);

  params.push(id);
  const result = ctx.db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  if (result.changes === 0) return c.json({ error: "goal not found" }, 404);

  const updated = ctx.db
    .prepare(
      `SELECT id, name, target_amount, allocated_amount, due_date, created_at, completed_at
       FROM goals WHERE id = ?`,
    )
    .get(id) as GoalRow;
  return c.json({ goal: decorateGoal(updated, ctx.today) });
});

route.post("/:id/allocate", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ amount?: unknown }>();
  if (typeof body.amount !== "number" || !Number.isFinite(body.amount)) {
    return c.json({ error: "amount must be a finite number" }, 400);
  }

  const result = ctx.db
    .prepare(`UPDATE goals SET allocated_amount = MAX(0, allocated_amount + ?) WHERE id = ?`)
    .run(body.amount, id);
  if (result.changes === 0) return c.json({ error: "goal not found" }, 404);

  const updated = ctx.db
    .prepare(
      `SELECT id, name, target_amount, allocated_amount, due_date, created_at, completed_at
       FROM goals WHERE id = ?`,
    )
    .get(id) as GoalRow;
  return c.json({ goal: decorateGoal(updated, ctx.today) });
});

route.post("/:id/archive", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = Number(c.req.param("id"));
  const result = ctx.db
    .prepare(`UPDATE goals SET completed_at = CURRENT_TIMESTAMP WHERE id = ? AND completed_at IS NULL`)
    .run(id);
  if (result.changes === 0) {
    const exists = ctx.db.prepare(`SELECT 1 FROM goals WHERE id = ?`).get(id);
    if (!exists) return c.json({ error: "goal not found" }, 404);
  }
  const updated = ctx.db
    .prepare(
      `SELECT id, name, target_amount, allocated_amount, due_date, created_at, completed_at
       FROM goals WHERE id = ?`,
    )
    .get(id) as GoalRow;
  return c.json({ goal: decorateGoal(updated, ctx.today) });
});

route.delete("/:id", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = Number(c.req.param("id"));
  const result = ctx.db.prepare(`DELETE FROM goals WHERE id = ?`).run(id);
  if (result.changes === 0) return c.json({ error: "goal not found" }, 404);
  return c.json({ ok: true });
});

export default route;
