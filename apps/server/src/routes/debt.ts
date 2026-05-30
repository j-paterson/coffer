import { Hono } from "hono";
import type { Ctx } from "../ctx";
import type { DebtAccount, DebtStrategy } from "../../../../packages/shared/types";

const route = new Hono();

function loadDebt(ctx: Ctx): DebtAccount[] {
  // Balance comes from the latest balance_assertion (SimpleFIN / Kubera
  // ground truth), not cumulative postings. The ledger drifts between
  // statement-date pads and fresh assertions, producing under-reported
  // card balances. Assertions are the canonical "what the issuer says."
  return ctx.db
    .prepare(
      /* sql */ `
      WITH latest_asserts AS (
        SELECT b.account_id, b.expected_usd, b.as_of
        FROM balance_assertions b
        JOIN (
          SELECT account_id, MAX(as_of) AS as_of
          FROM balance_assertions
          GROUP BY account_id
        ) mx ON mx.account_id = b.account_id AND mx.as_of = b.as_of
      )
      SELECT
        a.id AS account_id,
        COALESCE(a.display_name_override, a.display_name) AS display_name,
        ABS(la.expected_usd) AS balance,
        d.apr, d.min_payment_pct, d.min_payment_floor,
        d.promo_balance, d.promo_apr, d.promo_expires_at, d.notes
      FROM accounts a
      JOIN latest_asserts la ON la.account_id = a.id
      LEFT JOIN debt_terms d ON d.account_id = a.id
      WHERE a.type = 'credit' AND a.active = 1
        AND a.merged_into IS NULL
        AND la.expected_usd < 0
      ORDER BY ABS(la.expected_usd) DESC
      `,
    )
    .all() as DebtAccount[];
}

route.get("/", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const accounts = loadDebt(ctx);
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const minimums = accounts.reduce((s, a) => s + minPayment(a), 0);
  const weightedApr = total > 0
    ? accounts.reduce((s, a) => s + (a.apr ?? 0) * a.balance, 0) / total
    : 0;
  return c.json({
    accounts,
    total_debt: total,
    monthly_minimums: minimums,
    weighted_avg_apr: weightedApr,
  });
});

route.patch("/:account_id", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = c.req.param("account_id");
  const body = await c.req.json<Partial<DebtAccount>>();
  const fields = ["apr", "min_payment_pct", "min_payment_floor",
                  "promo_balance", "promo_apr", "promo_expires_at", "notes"] as const;
  const sets: string[] = [];
  const values: (number | string | null)[] = [];
  for (const f of fields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      values.push((body as Record<string, number | string | null | undefined>)[f] ?? null);
    }
  }
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  ctx.db
    .prepare(
      `INSERT INTO debt_terms (account_id, apr) VALUES (?, ?)
       ON CONFLICT(account_id) DO NOTHING`,
    )
    .run(id, body.apr ?? 0);
  ctx.db
    .prepare(
      `UPDATE debt_terms SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?`,
    )
    .run(...values, id);
  return c.json({ id, ok: true });
});

route.post("/plan", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const body = await c.req.json<{
    monthly_extra: number;
    strategy: DebtStrategy;
  }>();
  const accounts = loadDebt(ctx);
  const result = simulate(accounts, body.monthly_extra, body.strategy);
  return c.json(result);
});

function minPayment(a: DebtAccount): number {
  if (!a.apr) return 0;
  const pct = a.min_payment_pct ?? 0.02;
  const floor = a.min_payment_floor ?? 25;
  return Math.max(floor, a.balance * pct);
}

interface PlanState {
  account_id: string;
  display_name: string;
  balance: number;
  apr: number;
  promo_balance: number;
  promo_apr: number;
  promo_expires_at: string | null;
  paid_off_month: number | null;
  total_interest: number;
  series: { month: number; balance: number }[];
}

export function simulate(
  accounts: DebtAccount[],
  monthlyExtra: number,
  strategy: DebtStrategy,
) {
  const today = new Date();
  const states: PlanState[] = accounts.map((a) => ({
    account_id: a.account_id,
    display_name: a.display_name,
    balance: a.balance,
    apr: a.apr ?? 0.20, // fallback if user hasn't entered terms
    promo_balance: a.promo_balance ?? 0,
    promo_apr: a.promo_apr ?? 0,
    promo_expires_at: a.promo_expires_at,
    paid_off_month: null,
    total_interest: 0,
    series: [{ month: 0, balance: a.balance }],
  }));

  // Capture initial total minimums so we can hold the user's monthly
  // budget constant as cards pay off — freed-up minimums cascade into
  // the extra-payment pool rather than disappearing.
  const initialMinsTotal = states.reduce((sum, s, i) => {
    const a = accounts[i];
    return sum + Math.max(
      a.min_payment_floor ?? 25,
      s.balance * (a.min_payment_pct ?? 0.02),
    );
  }, 0);
  const monthlyBudget = initialMinsTotal + monthlyExtra;

  const MAX_MONTHS = 600; // 50-year safety bound
  let month = 0;
  while (month < MAX_MONTHS && states.some((s) => s.balance > 0.01)) {
    month += 1;
    const monthDate = new Date(today.getFullYear(), today.getMonth() + month, 1);

    for (const s of states) {
      if (s.balance <= 0.01) continue;
      // Promo balance has expired? Roll into regular balance.
      if (s.promo_expires_at && s.promo_balance > 0) {
        const exp = new Date(s.promo_expires_at);
        if (monthDate > exp) {
          s.promo_balance = 0; // promo expired — entire balance now at regular APR
        }
      }
      const promoPart = Math.min(s.promo_balance, s.balance);
      const regularPart = s.balance - promoPart;
      const monthlyRegInterest = regularPart * (s.apr / 12);
      const monthlyPromoInterest = promoPart * (s.promo_apr / 12);
      const interest = monthlyRegInterest + monthlyPromoInterest;
      s.balance += interest;
      s.total_interest += interest;
    }

    const mins = states.map((s) =>
      s.balance <= 0.01 ? 0 : Math.max(
        accounts.find((a) => a.account_id === s.account_id)?.min_payment_floor ?? 25,
        s.balance * (accounts.find((a) => a.account_id === s.account_id)?.min_payment_pct ?? 0.02),
      ),
    );
    const totalMins = mins.reduce((a, b) => a + b, 0);

    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (s.balance <= 0.01) continue;
      const pay = Math.min(mins[i], s.balance);
      s.balance -= pay;
    }

    // Budget is fixed (initial mins + extra). As cards pay off, totalMins
    // shrinks and the freed amount cascades to extra — the standard
    // "rolling" snowball/avalanche behavior. Without this, the simulator
    // under-shoots payoff speed by hundreds of dollars per cleared card.
    let extraRemaining = monthlyBudget - totalMins;

    const ordered = orderForStrategy(states, accounts, strategy);
    if (strategy === "even") {
      const unpaid = ordered.filter((s) => s.balance > 0.01);
      if (unpaid.length > 0) {
        const each = extraRemaining / unpaid.length;
        for (const s of unpaid) {
          const pay = Math.min(each, s.balance);
          s.balance -= pay;
        }
      }
    } else {
      for (const s of ordered) {
        if (extraRemaining <= 0) break;
        if (s.balance <= 0.01) continue;
        const pay = Math.min(extraRemaining, s.balance);
        s.balance -= pay;
        extraRemaining -= pay;
      }
    }

    for (const s of states) {
      s.series.push({ month, balance: Math.max(0, s.balance) });
      if (s.paid_off_month === null && s.balance <= 0.01) {
        s.paid_off_month = month;
      }
    }
  }

  const totalInterest = states.reduce((a, s) => a + s.total_interest, 0);
  const monthsToZero = states.reduce(
    (m, s) => Math.max(m, s.paid_off_month ?? MAX_MONTHS),
    0,
  );

  return {
    strategy: monthlyExtra,
    months_to_zero: monthsToZero,
    total_interest: totalInterest,
    accounts: states.map((s) => ({
      account_id: s.account_id,
      display_name: s.display_name,
      starting_balance: accounts.find((a) => a.account_id === s.account_id)?.balance ?? 0,
      paid_off_month: s.paid_off_month,
      total_interest: s.total_interest,
      series: s.series,
    })),
  };
}

function orderForStrategy(
  states: PlanState[],
  accounts: DebtAccount[],
  strategy: DebtStrategy,
): PlanState[] {
  const sorted = [...states];
  if (strategy === "avalanche") {
    // Effective APR blends regular + promo portions to avoid misordering
    // when a promo rate applies to only part of the balance.
    sorted.sort((a, b) => effectiveApr(b) - effectiveApr(a));
  } else if (strategy === "snowball") {
    sorted.sort((a, b) => {
      if (a.balance <= 0.01) return 1;
      if (b.balance <= 0.01) return -1;
      return a.balance - b.balance;
    });
  }
  return sorted;
}

function effectiveApr(s: PlanState): number {
  if (s.balance <= 0) return 0;
  const promoPart = Math.min(s.promo_balance, s.balance);
  const regularPart = s.balance - promoPart;
  return (regularPart * s.apr + promoPart * s.promo_apr) / s.balance;
}

export default route;
