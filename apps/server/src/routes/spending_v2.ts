/** Spending breakdown computed from double-entry postings.
 *
 * In the v2 model, "spending" is a negative posting on a real (non-equity)
 * account whose transaction has no other non-equity posting. That
 * distinguishes it from transfers (two real-account legs) by structure
 * alone, and from opening-balance reconciliation rows (counterparty
 * is equity:opening-balance).
 *
 * Category lives on transaction_items (item-level). Amount + account
 * live on postings. Joins on `t.id = p.txn_id`.
 *
 * Spending-only filter: transactions_v2.excluded_from_spending = 0. The
 * column is the user-facing "ignore in spending" toggle. Cashflow,
 * net worth, and balance walks intentionally do NOT consult it — see
 * docs/superpowers/specs/2026-04-28-ignore-in-spending-design.md.
 */

import { Hono } from "hono";
import { attachReceipts } from "../lib/attachReceipts";
import type { Ctx } from "../ctx";
import { dateSqlClause } from "@coffer/ledger/walker";
import type {
  CategoryBreakdownRow,
  ItemsByCategory,
  SpendingBreakdown,
  SpendingTransactionsResponse,
  SubcategoryRow,
  TransactionRow,
} from "../../../../packages/shared/types";

const route = new Hono();

// Predicate fragment: this posting is a real spend, not a transfer
// leg or crypto wallet movement.
//
//   - amount < 0 on a real (non-equity) account
//   - not derived from CoinTracker — CoinTracker rows are wallet
//     movements (BUY/SELL/SEND/RECEIVE/TRADE), not merchant spending;
//     including them inflates "Crypto" with $200k+ of pure transfers
//   - the txn has no other posting on a real account (= it's
//     one-sided to equity:unknown-counterparty, the merchant slot)
//   - excluded_from_spending = 0 (default; flipped via PATCH below)
//
// NOTE: Transfer filtering is now done via item-level category on the
// by-category endpoint. This predicate is used by the /transactions
// sub-endpoint which filters by a caller-supplied category.
const SPEND_PREDICATE = `
  p.amount < 0
  AND p.account_id NOT LIKE 'equity:%'
  AND t.derived_by != 'cointracker'
  AND t.excluded_from_spending = 0
  AND NOT EXISTS (
    SELECT 1 FROM postings p2
    WHERE p2.txn_id = p.txn_id
      AND p2.id != p.id
      AND p2.account_id NOT LIKE 'equity:%'
  )
`;

route.get("/by-category", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const from = c.req.query("from") ?? null;
  const to = c.req.query("to") ?? null;

  const { clause: dateClause, params: dateParams } = dateSqlClause("t.date", { from, to });
  const params: (string | number)[] = [...dateParams];

  const aggregates = ctx.db
    .prepare(
      `
      SELECT COALESCE(
               (SELECT i.category FROM transaction_items i WHERE i.transaction_v2_id = t.id ORDER BY i.id LIMIT 1),
               'Uncategorized'
             ) AS category,
             COUNT(DISTINCT t.id) AS count,
             SUM(p.amount) AS total
      FROM postings p
      JOIN transactions_v2 t ON t.id = p.txn_id
      WHERE p.amount < 0
        AND p.account_id NOT LIKE 'equity:%'
        AND t.derived_by != 'cointracker'
        AND t.excluded_from_spending = 0
        AND COALESCE(
          (SELECT i.category FROM transaction_items i WHERE i.transaction_v2_id = t.id ORDER BY i.id LIMIT 1),
          ''
        ) != 'Transfer'
        AND NOT EXISTS (
          SELECT 1 FROM postings p2
          WHERE p2.txn_id = p.txn_id
            AND p2.id != p.id
            AND p2.account_id NOT LIKE 'equity:%'
        )
        ${dateClause}
      GROUP BY category
      ORDER BY ABS(SUM(p.amount)) DESC
      `,
    )
    .all(...params) as Array<{
      category: string;
      count: number;
      total: number;
    }>;

  // Merchant breakdown stays at txn-level: top 5 merchants per category.
  const merchantStmt = ctx.db.prepare(
    `
    SELECT t.description AS description, COUNT(DISTINCT t.id) AS count, SUM(p.amount) AS total
    FROM postings p
    JOIN transactions_v2 t ON t.id = p.txn_id
    WHERE p.amount < 0
      AND p.account_id NOT LIKE 'equity:%'
      AND t.derived_by != 'cointracker'
      AND t.excluded_from_spending = 0
      AND COALESCE(
        (SELECT i.category FROM transaction_items i WHERE i.transaction_v2_id = t.id ORDER BY i.id LIMIT 1),
        ''
      ) != 'Transfer'
      AND NOT EXISTS (
        SELECT 1 FROM postings p2
        WHERE p2.txn_id = p.txn_id
          AND p2.id != p.id
          AND p2.account_id NOT LIKE 'equity:%'
      )
      AND COALESCE(
        (SELECT i.category FROM transaction_items i WHERE i.transaction_v2_id = t.id ORDER BY i.id LIMIT 1),
        'Uncategorized'
      ) = ?
      ${dateClause}
    GROUP BY t.description
    ORDER BY ABS(SUM(p.amount)) DESC
    LIMIT 5
    `,
  );

  const rows: CategoryBreakdownRow[] = aggregates.map((agg) => {
    const merchants = merchantStmt.all(agg.category, ...params) as Array<{
      description: string;
      count: number;
      total: number;
    }>;
    return {
      category: agg.category,
      count: agg.count,
      total: agg.total,
      top_merchants: merchants,
    };
  });

  const total_spend = rows.reduce((s, r) => s + r.total, 0);

  const response: SpendingBreakdown = { from, to, total_spend, rows };
  return c.json(response);
});

route.get("/transactions", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const category = c.req.query("category");
  if (!category) {
    return c.json({ error: "category query param required" }, 400);
  }
  const from = c.req.query("from") ?? null;
  const to = c.req.query("to") ?? null;
  const includeExcluded = c.req.query("include_excluded") === "1";

  const { clause: dateClause, params: dateParams } = dateSqlClause("t.date", { from, to });

  // SPEND_PREDICATE includes the excluded_from_spending=0 guard. For
  // include_excluded=1, drop only that filter; keep all the other
  // structural rules (real-account leg, not transfer, single non-equity
  // posting, etc.).
  const predicate = includeExcluded
    ? SPEND_PREDICATE.replace("AND t.excluded_from_spending = 0", "")
    : SPEND_PREDICATE;
  const whereSql = `${predicate}
    AND COALESCE(
      (SELECT i.category FROM transaction_items i WHERE i.transaction_v2_id = t.id ORDER BY i.id LIMIT 1),
      'Uncategorized'
    ) = ?
    ${dateClause}`;
  const params: (string | number)[] = [category, ...dateParams];

  const raw = ctx.db
    .prepare(
      `
      SELECT CAST(t.id AS TEXT) AS id,
             p.account_id AS account_id,
             t.date AS date,
             p.amount AS amount,
             t.description AS description,
             NULL AS merchant,
             (SELECT i.subcategory FROM transaction_items i WHERE i.transaction_v2_id = t.id ORDER BY i.id LIMIT 1) AS subcategory,
             t.tags AS tags,
             p.payee AS payee,
             p.memo AS memo,
             NULL AS location_hint,
             NULL AS bundle_id,
             t.excluded_from_spending AS excluded_int
      FROM postings p
      JOIN transactions_v2 t ON t.id = p.txn_id
      WHERE ${whereSql}
      ORDER BY ABS(p.amount) DESC, t.date DESC
      `,
    )
    .all(...params) as Array<TransactionRow & { excluded_int: number }>;
  const rows: TransactionRow[] = raw.map(({ excluded_int, ...rest }) => ({
    ...rest,
    excluded_from_spending: excluded_int === 1,
  }));
  attachReceipts(ctx, rows);

  // Always compute the count of excluded rows in this window/category so
  // the UI can show "Show N ignored" without a second roundtrip. The
  // predicate is the spending predicate with the excluded filter inverted.
  const excludedCountPredicate = SPEND_PREDICATE.replace(
    "AND t.excluded_from_spending = 0",
    "AND t.excluded_from_spending = 1",
  );
  const excludedCountWhere = `${excludedCountPredicate}
    AND COALESCE(
      (SELECT i.category FROM transaction_items i WHERE i.transaction_v2_id = t.id ORDER BY i.id LIMIT 1),
      'Uncategorized'
    ) = ?
    ${dateClause}`;
  const excludedRow = ctx.db
    .prepare(
      `SELECT COUNT(DISTINCT t.id) AS n
       FROM postings p
       JOIN transactions_v2 t ON t.id = p.txn_id
       WHERE ${excludedCountWhere}`,
    )
    .get(...params) as { n: number };

  const response: SpendingTransactionsResponse = {
    rows,
    excluded_count: excludedRow.n,
  };
  return c.json(response);
});

// Drill-down: bucket attached transaction_items by their item-level
// subcategory within a given top-level category. v2: items have
// transaction_v2_id pointing at transactions_v2.id.
route.get("/items-by-category", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const parent = c.req.query("parent");
  if (!parent) return c.json({ error: "parent query param required" }, 400);
  const from = c.req.query("from") ?? null;
  const to = c.req.query("to") ?? null;

  const { clause: dateClause, params: dateParams } = dateSqlClause("t.date", { from, to });
  // Filter items that belong to the requested parent category (or 'Uncategorized').
  // Excluded txns are dropped via t.excluded_from_spending=0 in the inner
  // queries; this endpoint has no include_excluded variant because the
  // drill-down is always scoped to "active spend".
  const whereSql = `COALESCE(ti.category, 'Uncategorized') = ? ${dateClause}`;
  const params: (string | number)[] = [parent, ...dateParams];

  const totals = ctx.db
    .prepare(
      `SELECT COUNT(DISTINCT ti.id) AS total_items,
              SUM(CASE WHEN ti.subcategory IS NOT NULL THEN 1 ELSE 0 END) AS classified
       FROM transactions_v2 t
       JOIN postings p ON p.txn_id = t.id
       JOIN transaction_items ti ON ti.transaction_v2_id = t.id
       WHERE ${whereSql}
         AND p.amount < 0
         AND p.account_id NOT LIKE 'equity:%'
         AND t.derived_by != 'cointracker'
         AND t.excluded_from_spending = 0
         AND NOT EXISTS (
           SELECT 1 FROM postings p2
           WHERE p2.txn_id = p.txn_id
             AND p2.id != p.id
             AND p2.account_id NOT LIKE 'equity:%'
         )`,
    )
    .get(...params) as { total_items: number; classified: number } | undefined;

  const buckets = ctx.db
    .prepare(
      `SELECT ti.subcategory AS category, COUNT(DISTINCT ti.id) AS count,
              SUM(COALESCE(ti.line_total, ti.unit_price * COALESCE(ti.quantity, 1), 0)) AS total
       FROM transactions_v2 t
       JOIN postings p ON p.txn_id = t.id
       JOIN transaction_items ti ON ti.transaction_v2_id = t.id
       WHERE ${whereSql}
         AND p.amount < 0
         AND p.account_id NOT LIKE 'equity:%'
         AND t.derived_by != 'cointracker'
         AND t.excluded_from_spending = 0
         AND NOT EXISTS (
           SELECT 1 FROM postings p2
           WHERE p2.txn_id = p.txn_id
             AND p2.id != p.id
             AND p2.account_id NOT LIKE 'equity:%'
         )
       GROUP BY ti.subcategory
       ORDER BY total DESC NULLS LAST`,
    )
    .all(...params) as Array<SubcategoryRow>;

  const response: ItemsByCategory = {
    parent,
    total_items: totals?.total_items ?? 0,
    classified: totals?.classified ?? 0,
    unclassified: (totals?.total_items ?? 0) - (totals?.classified ?? 0),
    subcategories: buckets,
  };
  return c.json(response);
});

route.patch("/transactions/:id/exclude", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  let body: { excluded?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  if (typeof body.excluded !== "boolean") {
    return c.json({ error: "excluded must be a boolean" }, 400);
  }
  const result = ctx.db
    .prepare(`UPDATE transactions_v2 SET excluded_from_spending = ? WHERE id = ?`)
    .run(body.excluded ? 1 : 0, id);
  if (result.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, excluded: body.excluded });
});

export default route;
