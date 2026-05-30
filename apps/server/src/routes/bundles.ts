import { Hono } from "hono";
import crypto from "node:crypto";
import type { Bundle, BundleDetail, BundleType, CategoryOption, TransactionRow } from "../../../../packages/shared/types";
import { attachReceipts } from "../lib/attachReceipts";
import type { Ctx } from "../ctx";
import { dateSqlClause } from "@coffer/ledger/walker";
import { BUNDLE_TEMPLATES } from "../lib/bundle_templates";

const route = new Hono();

function recomputeAggregates(ctx: Ctx, bundleId: string) {
  const row = ctx.db
    .prepare(
      `SELECT MIN(t.date) AS start_date,
              MAX(t.date) AS end_date,
              COALESCE(SUM(p.amount), 0) AS total_usd,
              COUNT(DISTINCT t.id) AS txn_count
       FROM transactions_v2 t
       JOIN postings p ON p.txn_id = t.id
       WHERE t.trip_id = ?
         AND p.account_id NOT LIKE 'equity:%'`,
    )
    .get(bundleId) as {
      start_date: string | null;
      end_date: string | null;
      total_usd: number;
      txn_count: number;
    };

  if (row.start_date) {
    ctx.db
      .prepare(
        `UPDATE bundles SET start_date = ?, end_date = ?, total_usd = ?, txn_count = ?
         WHERE id = ?`,
      )
      .run(row.start_date, row.end_date, row.total_usd, row.txn_count, bundleId);
  }
}

route.get("/", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const type = c.req.query("type");
  const whereClause = type ? "WHERE type = ?" : "";
  const params = type ? [type] : [];
  const rows = ctx.db
    .prepare(
      `SELECT id, slug, name, type, start_date, end_date, total_usd, txn_count
       FROM bundles ${whereClause}
       ORDER BY start_date DESC`,
    )
    .all(...params) as Omit<Bundle, "category_options">[];
  return c.json(rows);
});

route.post("/", (c) => {
  return (async () => {
    const ctx = c.get("ctx") as Ctx;
    const body = await c.req.json<{
      name: string;
      type: string;
      notes?: string;
    }>();
    if (!body.name || !body.type) {
      return c.json({ error: "name and type are required" }, 400);
    }
    const id = `${body.type}-${crypto.randomBytes(4).toString("hex")}`;
    const slug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const today = new Date().toISOString().slice(0, 10);
    const template = BUNDLE_TEMPLATES[body.type as BundleType] ?? [];

    ctx.db
      .prepare(
        `INSERT INTO bundles (id, slug, name, type, start_date, end_date, notes, category_options)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, slug, body.name, body.type, today, today, body.notes ?? null, JSON.stringify(template));

    const rawBundle = ctx.db
      .prepare(
        `SELECT id, slug, name, type, start_date, end_date, total_usd, txn_count,
                category_options
         FROM bundles WHERE id = ?`,
      )
      .get(id) as RawBundle;

    const bundle: Bundle = {
      ...rawBundle,
      category_options: JSON.parse(rawBundle.category_options ?? "[]") as CategoryOption[],
    };

    return c.json(bundle, 201);
  })();
});

type RawBundle = Omit<Bundle, "category_options"> & { category_options: string };

route.get("/:id", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = c.req.param("id");
  const raw = ctx.db
    .prepare(
      `SELECT id, slug, name, type, start_date, end_date, total_usd, txn_count,
              category_options
       FROM bundles WHERE id = ?`,
    )
    .get(id) as RawBundle | undefined;
  if (!raw) return c.json({ error: "bundle not found" }, 404);

  const bundle: Bundle = {
    ...raw,
    category_options: JSON.parse(raw.category_options ?? "[]") as CategoryOption[],
  };

  const transactions = ctx.db
    .prepare(
      `SELECT CAST(t.id AS TEXT) AS id,
              p.account_id        AS account_id,
              t.date              AS date,
              p.amount            AS amount,
              t.description       AS description,
              NULL                AS merchant,
              NULL                AS subcategory,
              t.tags              AS tags,
              p.payee             AS payee,
              p.memo              AS memo,
              NULL                AS location_hint,
              t.trip_id           AS bundle_id
       FROM transactions_v2 t
       JOIN postings p ON p.txn_id = t.id
       WHERE t.trip_id = ?
         AND p.account_id NOT LIKE 'equity:%'
       ORDER BY t.date, t.id`,
    )
    .all(id) as TransactionRow[];

  attachReceipts(ctx, transactions);

  const detail: BundleDetail = { ...bundle, transactions };
  return c.json(detail);
});

route.get("/:id/search", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = c.req.param("id");
  const q = c.req.query("q") ?? "";
  const from = c.req.query("from");
  const to = c.req.query("to");

  const where: string[] = [
    "p.account_id NOT LIKE 'equity:%'",
    "(t.trip_id IS NULL OR t.trip_id = ?)",
  ];
  const params: (string | number)[] = [id];

  if (q) {
    where.push("(t.description LIKE ? OR p.payee LIKE ? OR p.memo LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const { clause: dateClause, params: dateParams } = dateSqlClause("t.date", { from, to });
  if (dateClause) {
    where.push(dateClause.replace(/^AND /, ""));
    params.push(...dateParams);
  }

  const rows = ctx.db
    .prepare(
      `SELECT CAST(t.id AS TEXT) AS id,
              p.account_id AS account_id,
              t.date AS date,
              p.amount AS amount,
              t.description AS description,
              NULL AS merchant,
              NULL AS subcategory,
              t.tags AS tags,
              p.payee AS payee,
              p.memo AS memo,
              NULL AS location_hint,
              t.trip_id AS bundle_id
       FROM transactions_v2 t
       JOIN postings p ON p.txn_id = t.id
       WHERE ${where.join(" AND ")}
       ORDER BY t.date DESC
       LIMIT 100`,
    )
    .all(...params) as TransactionRow[];

  attachReceipts(ctx, rows);
  return c.json(rows);
});

route.post("/:id/transactions", (c) => {
  return (async () => {
    const ctx = c.get("ctx") as Ctx;
    const id = c.req.param("id");
    const bundle = ctx.db
      .prepare("SELECT id FROM bundles WHERE id = ?")
      .get(id);
    if (!bundle) return c.json({ error: "bundle not found" }, 404);

    const body = await c.req.json<{ txn_ids: number[] }>();
    if (!Array.isArray(body.txn_ids) || body.txn_ids.length === 0) {
      return c.json({ error: "txn_ids array required" }, 400);
    }

    const placeholders = body.txn_ids.map(() => "?").join(",");
    const result = ctx.db
      .prepare(
        `UPDATE transactions_v2 SET trip_id = ? WHERE id IN (${placeholders})`,
      )
      .run(id, ...body.txn_ids);

    recomputeAggregates(ctx, id);
    return c.json({ added: result.changes });
  })();
});

route.delete("/:id/transactions", (c) => {
  return (async () => {
    const ctx = c.get("ctx") as Ctx;
    const id = c.req.param("id");
    const body = await c.req.json<{ txn_ids: number[] }>();
    if (!Array.isArray(body.txn_ids) || body.txn_ids.length === 0) {
      return c.json({ error: "txn_ids array required" }, 400);
    }

    const placeholders = body.txn_ids.map(() => "?").join(",");
    const result = ctx.db
      .prepare(
        `UPDATE transactions_v2 SET trip_id = NULL
         WHERE trip_id = ? AND id IN (${placeholders})`,
      )
      .run(id, ...body.txn_ids);

    recomputeAggregates(ctx, id);
    return c.json({ removed: result.changes });
  })();
});

route.patch("/:id/category_options", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = c.req.param("id");

  let body: { category_options: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  if (!Array.isArray(body.category_options)) {
    return c.json({ error: "category_options must be an array" }, 400);
  }
  for (const o of body.category_options) {
    const rec = o as Record<string, unknown>;
    if (
      typeof o !== "object" || o === null ||
      typeof rec.category !== "string" ||
      !Array.isArray(rec.subcategories) ||
      !(rec.subcategories as unknown[]).every((s: unknown) => typeof s === "string")
    ) {
      return c.json({ error: "each option needs {category:string, subcategories:string[]}" }, 400);
    }
  }

  const result = ctx.db
    .prepare(`UPDATE bundles SET category_options = ? WHERE id = ?`)
    .run(JSON.stringify(body.category_options), id);
  if (result.changes === 0) return c.json({ error: "bundle not found" }, 404);
  return c.json({ ok: true, category_options: body.category_options });
});

export default route;
