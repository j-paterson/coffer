import type { Database } from "bun:sqlite";
import type { PrefillResponse, PortfolioComposition, Scenario, TaxProfile } from "../../../../../packages/shared/types";
import { DEFAULT_COMPOSITION } from "../../../../../packages/shared/types";

// Intentionally broad; false positives like "Bondurant Brokerage" or "Treasury Wine"
// are mitigated by the 30% threshold. Tighten with word boundaries (\bbond\b) if
// false positives surface in real data.
const BOND_NAME_RE = /bond|treasury|mmf|BND|VGIT/i;
const BOND_FRACTION_THRESHOLD = 0.30;

const DEFAULT_HELOC_APR = 0.0725;
const DEFAULT_HELOC_TERM_MONTHS = 360;
const DEFAULT_RETURN = 0.065;
const DEFAULT_VOL = 0.15;
const DEFAULT_HOME_APPREC = 0.03;
const DEFAULT_HORIZON = 360;
// Blended ordinary yield across taxable holdings: mix of MMF/T-bill interest,
// REIT ordinary dividends, short-term gains. Conservative seed; user edits
// the exact value in the Tax card once they see the estimate.
const ASSUMED_TAXABLE_ORDINARY_YIELD_ANNUAL = 0.015;

function latestBalance(db: Database, accountId: string): number | null {
  const row = db
    .query<{ expected_usd: number }, [string]>(
      `SELECT expected_usd FROM balance_assertions WHERE account_id = ? ORDER BY as_of DESC LIMIT 1`,
    )
    .get(accountId);
  return row?.expected_usd ?? null;
}

function detectHome(db: Database): { id: string; value: number } | null {
  const rows = db
    .query<{ id: string }, []>(
      `SELECT id FROM accounts WHERE type='real_estate' AND active=1 AND merged_into IS NULL`,
    )
    .all();
  for (const r of rows) {
    const v = latestBalance(db, r.id);
    if (v !== null && v > 0) return { id: r.id, value: v };
  }
  return null;
}

function detectMortgage(
  db: Database,
): { balance: number; apr: number; monthlyPayment: number } | null {
  const named = db
    .query<{ id: string }, []>(
      `SELECT id FROM accounts WHERE (display_name LIKE '%mortgage%' OR display_name LIKE '%home loan%') COLLATE NOCASE AND active=1`,
    )
    .all();

  type Cand = { id: string; apr: number; balance: number };
  const cands: Cand[] = [];
  for (const n of named) {
    const term = db
      .query<{ apr: number; min_payment_pct: number | null; min_payment_floor: number | null }, [string]>(
        `SELECT apr, min_payment_pct, min_payment_floor FROM debt_terms WHERE account_id = ?`,
      )
      .get(n.id);
    const bal = latestBalance(db, n.id);
    if (!term || bal === null) continue;
    cands.push({ id: n.id, apr: term.apr, balance: Math.abs(bal) });
  }

  if (cands.length === 0) {
    // Fallback: amortized low-rate debt against a non-credit account.
    // Credit cards with 0% promos would otherwise get picked up (promo
    // APR < 8%, balance a few hundred dollars), which then flows into
    // the scenario as "existingMortgage" and quietly subtracts from
    // available equity. Require type!=credit AND min_payment_pct<5%
    // (mortgages amortize slowly; revolving promos require pay-in-full).
    const rows = db
      .query<{ account_id: string; apr: number }, []>(
        `SELECT dt.account_id, dt.apr
         FROM debt_terms dt JOIN accounts a ON a.id = dt.account_id
         WHERE dt.apr < 0.08
           AND a.type != 'credit'
           AND (dt.min_payment_pct IS NULL OR dt.min_payment_pct < 0.05)`,
      )
      .all();
    for (const r of rows) {
      const bal = latestBalance(db, r.account_id);
      if (bal === null || Math.abs(bal) < 10000) continue;
      cands.push({ id: r.account_id, apr: r.apr, balance: Math.abs(bal) });
    }
  }

  if (cands.length === 0) return null;
  cands.sort((a, b) => b.balance - a.balance);
  const chosen = cands[0];
  const term = db
    .query<{ min_payment_pct: number | null; min_payment_floor: number | null }, [string]>(
      `SELECT min_payment_pct, min_payment_floor FROM debt_terms WHERE account_id = ?`,
    )
    .get(chosen.id);
  const pct = term?.min_payment_pct ?? 0.005;
  const floor = term?.min_payment_floor ?? 0;
  const monthlyPayment = Math.max(chosen.balance * pct, floor);
  return { balance: chosen.balance, apr: chosen.apr, monthlyPayment };
}

function loadTaxProfile(db: Database): TaxProfile | null {
  const r = db
    .query<
      {
        marginal_ordinary_rate: number;
        ltcg_rate: number;
        qualified_div_rate: number;
        ltcg_election: number;
        ordinary_investment_income_monthly: number;
      },
      []
    >(`SELECT * FROM tax_profile WHERE id = 1`)
    .get();
  if (!r) return null;
  return {
    marginalOrdinaryRate: r.marginal_ordinary_rate,
    ltcgRate: r.ltcg_rate,
    qualifiedDivRate: r.qualified_div_rate,
    ltcgElection: r.ltcg_election === 1,
    ordinaryInvestmentIncomeMonthly: r.ordinary_investment_income_monthly,
  };
}

function loadCashflow(db: Database): { income: number; expense: number } {
  const r = db
    .query<{ monthly_income: number | null; monthly_required_expense: number | null }, []>(
      `SELECT monthly_income, monthly_required_expense FROM cashflow_settings WHERE id = 1`,
    )
    .get();
  return { income: r?.monthly_income ?? 0, expense: r?.monthly_required_expense ?? 0 };
}

function estimateTaxableOrdinaryIncomeMonthly(db: Database): number {
  const rows = db
    .query<{ id: string }, []>(
      `SELECT id FROM accounts
       WHERE type IN ('brokerage','alt')
         AND active = 1
         AND merged_into IS NULL`,
    )
    .all();
  let total = 0;
  for (const r of rows) {
    const bal = latestBalance(db, r.id);
    if (bal !== null && bal > 0) total += bal;
  }
  return (total * ASSUMED_TAXABLE_ORDINARY_YIELD_ANNUAL) / 12;
}

function loadPortfolioValue(db: Database): number {
  const row = db
    .query<{ total: number | null }, []>(
      `WITH latest AS (
         SELECT position_id, MAX(as_of) AS mx
         FROM position_snapshots
         GROUP BY position_id
       )
       SELECT COALESCE(SUM(ps.value_usd), 0) AS total
       FROM position_snapshots ps
       JOIN latest l ON l.position_id = ps.position_id AND l.mx = ps.as_of
       JOIN positions p ON p.id = ps.position_id
       JOIN accounts a ON a.id = p.account_id
       WHERE a.active = 1 AND a.merged_into IS NULL
         AND a.id NOT LIKE 'equity:%'
         AND ps.value_usd > 0`,
    )
    .get();
  return row?.total ?? 0;
}

/**
 * Inspects taxable brokerage/alt account names to estimate a bond sleeve fraction.
 * Returns a PortfolioComposition if more than 30% of taxable holdings are in
 * accounts whose display_name matches the bond name regex; otherwise undefined,
 * preserving the legacy all-equity single-asset path derived from baselineReturnPct.
 */
export function estimateBondSleeve(db: Database): PortfolioComposition | undefined {
  const rows = db
    .query<{ id: string; effective_name: string }, []>(
      `SELECT id, COALESCE(display_name_override, display_name) AS effective_name
       FROM accounts
       WHERE type IN ('brokerage','alt')
         AND active = 1
         AND merged_into IS NULL`,
    )
    .all();

  let bondTotal = 0;
  let allTotal = 0;
  for (const r of rows) {
    const bal = latestBalance(db, r.id);
    if (bal === null || bal <= 0) continue;
    allTotal += bal;
    if (BOND_NAME_RE.test(r.effective_name)) {
      bondTotal += bal;
    }
  }

  if (allTotal === 0) return undefined;
  const bondFraction = bondTotal / allTotal;
  if (bondFraction <= BOND_FRACTION_THRESHOLD) return undefined;

  const equityFraction = 1 - bondFraction;
  return {
    equity:    { ...DEFAULT_COMPOSITION.equity,    fraction: equityFraction },
    bond:      { ...DEFAULT_COMPOSITION.bond,      fraction: bondFraction },
    ordIncome: { ...DEFAULT_COMPOSITION.ordIncome, fraction: 0 },
  };
}

export function buildPrefill(db: Database): PrefillResponse {
  const home = detectHome(db);
  if (!home) {
    return { ok: false, requiresHome: true, message: "Add your home value below to use this sandbox." };
  }
  const rawTax = loadTaxProfile(db);
  if (!rawTax) {
    return { ok: false, requiresTaxProfile: true, message: "Set your tax profile before running projections." };
  }
  // Seed ordinary investment income from taxable brokerage balances when the
  // user hasn't set it explicitly. This makes §163(d) interest-deduction cap
  // non-trivial out of the box; users refine via the Tax card.
  const tax: TaxProfile = rawTax.ordinaryInvestmentIncomeMonthly > 0
    ? rawTax
    : { ...rawTax, ordinaryInvestmentIncomeMonthly: estimateTaxableOrdinaryIncomeMonthly(db) };
  const mortgage = detectMortgage(db);
  const availableEquity = Math.max(0, home.value - (mortgage?.balance ?? 0));
  const defaultDraw = Math.round(availableEquity * 0.20);
  const portfolio = loadPortfolioValue(db);
  const { income, expense } = loadCashflow(db);
  const composition = estimateBondSleeve(db);

  const scenario: Scenario = {
    startDate: new Date().toISOString().slice(0, 10),
    horizonMonths: DEFAULT_HORIZON,
    baselineReturnPct: DEFAULT_RETURN,
    baselineVolPct: DEFAULT_VOL,
    homeAppreciationPct: DEFAULT_HOME_APPREC,
    mc: { enabled: false, paths: 5000, seed: 42 },
    initialHomeValue: home.value,
    initialPortfolioValue: portfolio,
    existingMortgage: mortgage ?? undefined,
    monthlyIncome: income,
    monthlyExpense: expense,
    tax,
    events: [
      {
        kind: "take_loan",
        atMonth: 0,
        payload: {
          loan_id: "heloc",
          principal: defaultDraw,
          apr: DEFAULT_HELOC_APR,
          term_months: DEFAULT_HELOC_TERM_MONTHS,
          rate_type: "variable",
          closing_costs: 0,
          traced_to_investment: true,
        },
      },
      {
        kind: "invest_cash",
        atMonth: 0,
        payload: { amount: defaultDraw, into: "baseline", funded_by_loan_id: "heloc" },
      },
      {
        kind: "loan_payment_schedule",
        atMonth: 0,
        payload: { loan_id: "heloc", from: "earned_income" },
      },
    ],
    ...(composition !== undefined ? { composition } : {}),
  };

  return { ok: true, scenario, tax };
}
