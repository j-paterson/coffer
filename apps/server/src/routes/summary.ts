import { Hono } from "hono";
import type { Ctx } from "../ctx";
import { walkSeveralCanonicals, todayISO } from "@coffer/ledger/walker";
import type { Summary } from "../../../../packages/shared/types";

const route = new Hono();

// Headline summary — exact same walker as /api/networth/series uses,
// evaluated at today. Single path guarantees summary agrees with the
// chart's right-edge value.
route.get("/", (c) => {
  const today = todayISO();
  const ctx = c.get("ctx") as Ctx;

  // Canonical accounts: active, not merged, not equity ledger.
  // Inactive canonicals carry stale historical postings with no current
  // anchor; including them inflates net worth with long-ago activity
  // that was never closed out.
  const canonicals = (ctx.db
    .prepare(
      `SELECT id, type FROM accounts
       WHERE merged_into IS NULL
         AND id NOT LIKE 'equity:%'
         AND active = 1`
    )
    .all() as Array<{ id: string; type: string }>);

  const typeById = new Map(canonicals.map((r) => [r.id, r.type]));
  const ids = canonicals.map((r) => r.id);
  const walked = walkSeveralCanonicals(ctx, ids, undefined, today);

  let total_assets = 0;
  let total_debts = 0;
  let latest: string | null = null;

  for (const id of ids) {
    const series = walked.get(id);
    if (!series || series.size === 0) continue;
    // Latest date in the series that is ≤ today.
    let bestDate: string | null = null;
    for (const d of series.keys()) {
      if (d > today) continue;
      if (!bestDate || d > bestDate) bestDate = d;
    }
    if (!bestDate) continue;
    const bal = series.get(bestDate) ?? 0;
    if (bal > 0) total_assets += bal;
    else if (bal < 0) total_debts += -bal;
    if (!latest || bestDate > latest) latest = bestDate;
  }

  const counts = ctx.db
    .prepare(
      `SELECT
         COUNT(*) AS accounts,
         SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_accounts
       FROM accounts
       WHERE merged_into IS NULL AND id NOT LIKE 'equity:%'`,
    )
    .get() as { accounts: number; active_accounts: number };

  const summary: Summary = {
    net_worth: total_assets - total_debts,
    total_assets,
    total_debts,
    as_of: latest,
    counts,
  };

  return c.json(summary);
});

export default route;
