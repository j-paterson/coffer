/** Cashflow detector — v2.
 *
 * Reads from postings + transactions_v2 instead of v1 transactions, and
 * derives current credit balances from cumulative postings instead of
 * the v1 balances table. All other heuristics (income source detection,
 * required-spend categories, debt-minimum formula) stay identical.
 */

import { Hono } from "hono";
import type { Ctx } from "../ctx";
import type { CashflowResponse } from "../../../../packages/shared/types";

const route = new Hono();

const REQUIRED_CATEGORIES = [
  "Insurance",
  "Utilities",
  "Internet",
  "Healthcare",
  "Auto",
  "Groceries",
  "Gas",
  "Fees",
];


route.get("/", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const settings = ctx.db
    .prepare(
      "SELECT monthly_income, monthly_required_expense, pay_frequency, notes FROM cashflow_settings WHERE id = 1",
    )
    .get() as
    | {
        monthly_income: number | null;
        monthly_required_expense: number | null;
        pay_frequency: string | null;
        notes: string | null;
      }
    | undefined;

  const hasIncomeSourceColumn = ctx.db
    .prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'is_income_source'")
    .get() != null;
  const incomeSourceAccounts = hasIncomeSourceColumn
    ? (ctx.db
        .prepare("SELECT display_name FROM accounts WHERE is_income_source = 1")
        .all() as { display_name: string }[])
    : [];
  const incomeSourceSuffixes: string[] = [];
  for (const a of incomeSourceAccounts) {
    const m = a.display_name.match(/(\d{3,5})/);
    if (m) incomeSourceSuffixes.push(m[1]);
  }
  const sourceLikeClause = incomeSourceSuffixes
    .map(() => "t.description LIKE ?")
    .join(" OR ");
  const sourceLikeParams = incomeSourceSuffixes.map((s) => `%...${s}%`);

  // Income candidates: positive postings on real accounts in the last
  // 90d, ≥$100, excluding Transfer-tagged txns and payment/credit/coinbase
  // payee patterns. Also pulls in known annuity/income-source flows that
  // were transfer-paired (Shared Annuity disbursements, etc.).
  const INCOME_SQL = `
    SELECT t.id          AS id,
           p.amount       AS amount,
           t.date         AS date,
           p.payee        AS payee,
           t.description  AS description
    FROM postings p
    JOIN transactions_v2 t ON t.id = p.txn_id
    JOIN accounts a ON a.id = p.account_id
    WHERE p.account_id NOT LIKE 'equity:%'
      AND t.date >= date('now', '-90 days')
      AND p.amount > 0
      AND p.amount >= 100
      AND (
        (
          COALESCE(p.payee, '') NOT LIKE '%Payment%'
          AND COALESCE(p.payee, '') NOT LIKE '%Credit%'
          AND COALESCE(p.payee, '') NOT LIKE '%Transfer%'
          AND COALESCE(p.payee, '') NOT LIKE '%Coinbase%'
        )
        ${sourceLikeClause ? `OR (${sourceLikeClause})` : ""}
      )
  `;
  const incomeRows = ctx.db
    .prepare(INCOME_SQL)
    .all(...sourceLikeParams) as Array<{
    id: string;
    amount: number;
    payee: string | null;
    description: string;
  }>;
  const detectedIncome =
    incomeRows.reduce((s, r) => s + r.amount, 0) / 3;

  const placeholders = REQUIRED_CATEGORIES.map(() => "?").join(",");

  // Scalar required-spend: use EXISTS so the posting amount is never fanned
  // out across multiple item rows. Without EXISTS, a txn with N items would
  // multiply p.amount by N, inflating the total.
  const requiredRow = ctx.db
    .prepare(
      `
      SELECT COALESCE(SUM(ABS(p.amount)), 0) AS total
      FROM postings p
      JOIN transactions_v2 t ON t.id = p.txn_id
      WHERE p.amount < 0
        AND p.account_id NOT LIKE 'equity:%'
        AND t.date >= date('now', '-90 days')
        AND t.derived_by != 'cointracker'
        AND EXISTS (
          SELECT 1 FROM transaction_items i
          WHERE i.transaction_v2_id = t.id
            AND i.category IN (${placeholders})
        )
      `,
    )
    .get(...REQUIRED_CATEGORIES) as { total: number };
  const detectedRequired = requiredRow.total / 3;

  const sourceMap = new Map<string, { count: number; total: number }>();
  for (const r of incomeRows) {
    let source = r.payee ?? r.description;
    if (
      source === "Jo Solutions Inc Payroll" ||
      source === "Peo Jo Solution Payroll"
    ) {
      source = "Jo Solutions Payroll";
    }
    for (let i = 0; i < incomeSourceSuffixes.length; i++) {
      if (r.description.includes(`...${incomeSourceSuffixes[i]}`)) {
        source = `${incomeSourceAccounts[i].display_name} disbursement`;
        break;
      }
    }
    const existing = sourceMap.get(source) ?? { count: 0, total: 0 };
    existing.count += 1;
    existing.total += r.amount;
    sourceMap.set(source, existing);
  }
  const incomeBreakdown = [...sourceMap.entries()]
    .map(([source, v]) => ({
      source,
      count: v.count,
      monthly_avg: v.total / 3,
    }))
    .sort((a, b) => b.monthly_avg - a.monthly_avg)
    .slice(0, 12);

  // Breakdown by category: sum item line_totals (Option A) so that a single
  // txn split across multiple categories is attributed correctly per bucket.
  // We guard with EXISTS on postings to preserve the original spending filter
  // (negative, non-equity postings only). line_total is negative for spend,
  // so ABS gives the magnitude.
  const breakdown = ctx.db
    .prepare(
      `
      SELECT i.category AS category, COALESCE(SUM(ABS(i.line_total)), 0)/3.0 AS monthly_avg
      FROM transaction_items i
      JOIN transactions_v2 t ON t.id = i.transaction_v2_id
      WHERE i.category IN (${placeholders})
        AND t.date >= date('now', '-90 days')
        AND t.derived_by != 'cointracker'
        AND EXISTS (
          SELECT 1 FROM postings p
          WHERE p.txn_id = t.id
            AND p.amount < 0
            AND p.account_id NOT LIKE 'equity:%'
        )
      GROUP BY i.category
      ORDER BY monthly_avg DESC
      `,
    )
    .all(...REQUIRED_CATEGORIES) as { category: string; monthly_avg: number }[];

  // Debt minimums: cumulative postings give per-account current balance
  // (negative for credit). Same min-payment formula as before.
  const minRow = ctx.db
    .prepare(
      `
      WITH credit_balances AS (
        SELECT a.id, a.merged_into,
               SUM(p.amount) AS bal
        FROM accounts a
        JOIN postings p ON p.account_id = a.id
        WHERE a.type = 'credit' AND a.active = 1
        GROUP BY a.id
      )
      SELECT COALESCE(SUM(
        CASE
          WHEN d.apr IS NULL OR d.apr = 0 THEN 0
          ELSE MAX(
            COALESCE(d.min_payment_floor, 25),
            ABS(cb.bal) * COALESCE(d.min_payment_pct, 0.02)
          )
        END
      ), 0) AS minimums
      FROM credit_balances cb
      LEFT JOIN debt_terms d ON d.account_id = cb.id
      WHERE cb.bal < 0
      `,
    )
    .get() as { minimums: number };

  const effectiveIncome = settings?.monthly_income ?? detectedIncome;
  const effectiveRequired = settings?.monthly_required_expense ?? detectedRequired;
  const available = Math.max(
    0,
    effectiveIncome - effectiveRequired - minRow.minimums,
  );

  const payload: CashflowResponse = {
    detected_monthly_income: detectedIncome,
    detected_monthly_required: detectedRequired,
    user_monthly_income: settings?.monthly_income ?? null,
    user_monthly_required: settings?.monthly_required_expense ?? null,
    pay_frequency: settings?.pay_frequency ?? "monthly",
    monthly_minimums: minRow.minimums,
    effective_income: effectiveIncome,
    effective_required: effectiveRequired,
    available_for_debt: available,
    required_breakdown: breakdown,
    income_breakdown: incomeBreakdown,
    notes: settings?.notes ?? null,
  };
  return c.json(payload);
});

route.patch("/", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const body = await c.req.json<{
    monthly_income?: number | null;
    monthly_required_expense?: number | null;
    pay_frequency?: string | null;
    notes?: string | null;
  }>();
  const fields = ["monthly_income", "monthly_required_expense", "pay_frequency", "notes"] as const;
  const sets: string[] = [];
  const values: (number | string | null)[] = [];
  for (const f of fields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      values.push((body as Record<string, number | string | null | undefined>)[f] ?? null);
    }
  }
  if (sets.length === 0) return c.json({ error: "no fields to update" }, 400);
  ctx.db
    .prepare(
      `UPDATE cashflow_settings SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
    )
    .run(...values);
  return c.json({ ok: true });
});

export default route;
