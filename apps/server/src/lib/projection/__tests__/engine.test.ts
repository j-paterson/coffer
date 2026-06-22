import { test, expect } from "bun:test";
import { runDeterministic, initialState, step } from "../engine";
import { resolveComposition } from "../events";
import { reconcileYearEnd } from "../tax";
import type { Scenario } from "../../../../../../packages/shared/types";

const baseTax = {
  marginalOrdinaryRate: 0.32,
  ltcgRate: 0.238,
  qualifiedDivRate: 0.238,
  ltcgElection: false,
  ordinaryInvestmentIncomeMonthly: 0,
};

function makeScenario(partial: Partial<Scenario>): Scenario {
  return {
    startDate: "2026-01-01",
    horizonMonths: 120,
    baselineReturnPct: 0.07,
    baselineVolPct: 0.15,
    homeAppreciationPct: 0.03,
    mc: { enabled: false, paths: 0 },
    events: [],
    initialHomeValue: 500_000,
    initialPortfolioValue: 100_000,
    monthlyIncome: 10_000,
    monthlyExpense: 7_000,
    tax: baseTax,
    ...partial,
  };
}

test("zero-loan scenario: starting portfolio compounds + monthly surplus is reinvested", () => {
  const s = makeScenario({ baselineReturnPct: 0.06, horizonMonths: 12 });
  const t = runDeterministic(s);
  // Surplus (income - expense) = $3k/mo added to portfolio before each monthly compound.
  // Closed form: P_n = P_0·(1+r)^n + S·(1+r)·((1+r)^n − 1)/r   (annuity-due)
  const r = 0.06 / 12;
  const n = 12;
  const S = 10_000 - 7_000;
  const expected = 100_000 * Math.pow(1 + r, n) + S * (1 + r) * (Math.pow(1 + r, n) - 1) / r;
  expect(t.months.at(-1)!.portfolioValue).toBeCloseTo(expected, 0);
});

test("zero-loan, zero-return, zero-surplus: portfolio stays flat", () => {
  // Proves surplus reinvestment hinges on positive free cashflow, not a universal top-up.
  const s = makeScenario({ baselineReturnPct: 0, horizonMonths: 12, monthlyIncome: 5_000, monthlyExpense: 5_000 });
  const t = runDeterministic(s);
  expect(t.months.at(-1)!.portfolioValue).toBeCloseTo(100_000, 0);
});

test("home appreciates at homeAppreciationPct monthly", () => {
  const s = makeScenario({ homeAppreciationPct: 0.03, horizonMonths: 12 });
  const t = runDeterministic(s);
  const expected = 500_000 * Math.pow(1 + 0.03 / 12, 12);
  expect(t.months.at(-1)!.homeEquity).toBeCloseTo(expected, 0);
});

test("loan with 0% APR: portfolio grows by principal + reinvested net surplus (no interest)", () => {
  const s = makeScenario({
    horizonMonths: 24,
    baselineReturnPct: 0,
    events: [
      { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 50_000, apr: 0, term_months: 360, rate_type: "fixed", closing_costs: 0, traced_to_investment: true } },
      { kind: "invest_cash", atMonth: 0, payload: { amount: 50_000, into: "baseline", funded_by_loan_id: "L1" } },
      { kind: "loan_payment_schedule", atMonth: 0, payload: { loan_id: "L1", from: "earned_income" } },
    ],
  });
  const t = runDeterministic(s);
  const last = t.months.at(-1)!;
  // Starting $100k + $50k loan proceeds + 24 months of ($3k surplus − shrinking 0%-APR payments).
  // Net surplus over 24 months ≈ 24·$3k − total principal paid down over 24 months.
  // Cross-check: portfolio must exceed $150k (surplus reinvested) and loan partially paid.
  expect(last.portfolioValue).toBeGreaterThan(150_000);
  expect(last.portfolioValue).toBeLessThan(150_000 + 24 * 3_000);
  expect(last.loanBalance).toBeLessThan(50_000);
});

test("cashflow shortfall triggers forcedLiquidation and sells portfolio", () => {
  const s = makeScenario({
    horizonMonths: 12,
    monthlyIncome: 1_000,
    monthlyExpense: 800,
    events: [
      { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 200_000, apr: 0.10, term_months: 120, rate_type: "fixed", closing_costs: 0, traced_to_investment: true } },
      { kind: "invest_cash", atMonth: 0, payload: { amount: 200_000, into: "baseline", funded_by_loan_id: "L1" } },
      { kind: "loan_payment_schedule", atMonth: 0, payload: { loan_id: "L1", from: "earned_income" } },
    ],
  });
  const t = runDeterministic(s);
  expect(t.months.some((m) => m.forcedLiquidation)).toBe(true);
});

test("composition fractions that don't sum to 1 are normalized with a warning", () => {
  const s = makeScenario({
    horizonMonths: 1,
    composition: {
      equity:    { fraction: 0.6, expectedReturn: 0.06, volPct: 0.15, ordinaryYield: 0, qualifiedYield: 0 },
      bond:      { fraction: 0.6, expectedReturn: 0.04, volPct: 0.05, ordinaryYield: 0.04, qualifiedYield: 0 },
      ordIncome: { fraction: 0.6, expectedReturn: 0.05, volPct: 0.01, ordinaryYield: 0.05, qualifiedYield: 0 },
    },
  });
  const t = runDeterministic(s);
  expect(t.warnings.some((w) => w.kind === "composition_fractions_normalized")).toBe(true);
});

test("scenario without composition: no normalization warning, baseline behavior preserved", () => {
  const s = makeScenario({ baselineReturnPct: 0.06, horizonMonths: 12 });
  const t = runDeterministic(s);
  expect(t.warnings.some((w) => w.kind === "composition_fractions_normalized")).toBe(false);
  // Existing test "zero-loan scenario: starting portfolio compounds + monthly surplus is reinvested"
  // already covers numerical regression. Just confirming no regression here.
});

test("composition allocates initialPortfolioValue across sleeves by fraction", () => {
  const s = makeScenario({
    horizonMonths: 0,
    composition: {
      equity:    { fraction: 0.6, expectedReturn: 0.06, volPct: 0.15, ordinaryYield: 0,    qualifiedYield: 0 },
      bond:      { fraction: 0.3, expectedReturn: 0.04, volPct: 0.05, ordinaryYield: 0.04, qualifiedYield: 0 },
      ordIncome: { fraction: 0.1, expectedReturn: 0.05, volPct: 0.01, ordinaryYield: 0.05, qualifiedYield: 0 },
    },
  });
  const { composition } = resolveComposition(s);
  const state = initialState(s, composition);
  // initialPortfolioValue = 100_000 from makeScenario defaults
  expect(state.sleeves.equity).toBeCloseTo(60_000, 5);
  expect(state.sleeves.bond).toBeCloseTo(30_000, 5);
  expect(state.sleeves.ordIncome).toBeCloseTo(10_000, 5);
});

test("underwaterOnHome flags when home drops below (mortgage + HELOC)", () => {
  const s = makeScenario({
    horizonMonths: 12,
    homeAppreciationPct: 0,
    existingMortgage: { balance: 400_000, apr: 0.03, monthlyPayment: 2_000 },
    events: [
      { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 100_000, apr: 0.07, term_months: 360, rate_type: "variable", closing_costs: 0, traced_to_investment: true } },
      { kind: "invest_cash", atMonth: 0, payload: { amount: 100_000, into: "baseline", funded_by_loan_id: "L1" } },
      { kind: "market_shock", atMonth: 1, payload: { equity_drawdown_pct: 0, home_drawdown_pct: 0.20, duration_months: 1 } },
    ],
  });
  const t = runDeterministic(s);
  expect(t.months.some((m) => m.underwaterOnHome)).toBe(true);
});

test("50/50 equity/bond split produces weighted-average portfolio growth (closed-form check)", () => {
  // Zero-loan, zero monthly surplus (income == expense), 12-month horizon.
  // Equity: 6% annual, Bond: 4% annual, each starting at $50k.
  // Expected final: each sleeve compounds independently at its own rate.
  const s = makeScenario({
    horizonMonths: 12,
    monthlyIncome: 5_000,
    monthlyExpense: 5_000, // zero surplus so no reinvestment noise
    baselineReturnPct: 0,  // not used when composition is provided
    baselineVolPct: 0,
    composition: {
      equity:    { fraction: 0.5, expectedReturn: 0.06, volPct: 0.15, ordinaryYield: 0, qualifiedYield: 0 },
      bond:      { fraction: 0.5, expectedReturn: 0.04, volPct: 0.05, ordinaryYield: 0, qualifiedYield: 0 },
      ordIncome: { fraction: 0.0, expectedReturn: 0.00, volPct: 0.00, ordinaryYield: 0, qualifiedYield: 0 },
    },
  });
  const t = runDeterministic(s);
  const expected =
    50_000 * Math.pow(1 + 0.06 / 12, 12) +
    50_000 * Math.pow(1 + 0.04 / 12, 12);
  expect(t.months.at(-1)!.portfolioValue).toBeCloseTo(expected, 0);
});

test("ordinary-income accrual: 100% bond sleeve at 4% ordinaryYield grows ytdOrdinaryInvestIncome", () => {
  // Zero surplus (income == expense), 100% bond, 4% ordinary yield.
  // After one step: accrual = 100_000 * 0.04 / 12 ≈ 333.33.
  // Accrual happens before compound, on the post-cashflow sleeve balance ($100k unmodified here).
  const s = makeScenario({
    horizonMonths: 1,
    monthlyIncome: 5_000,
    monthlyExpense: 5_000,
    composition: {
      equity:    { fraction: 0, expectedReturn: 0,    volPct: 0,    ordinaryYield: 0,    qualifiedYield: 0 },
      bond:      { fraction: 1, expectedReturn: 0.04, volPct: 0,    ordinaryYield: 0.04, qualifiedYield: 0 },
      ordIncome: { fraction: 0, expectedReturn: 0,    volPct: 0,    ordinaryYield: 0,    qualifiedYield: 0 },
    },
  });
  const { composition } = resolveComposition(s);
  const state = initialState(s, composition);
  // Sanity: bond sleeve starts at $100k.
  expect(state.sleeves.bond).toBeCloseTo(100_000, 5);
  step(state, [], s.events, s, { sleeveReturns: { equity: 0, bond: 0.04 / 12, ordIncome: 0 } }, composition);
  expect(state.ytdOrdinaryInvestIncome).toBeCloseTo(100_000 * 0.04 / 12, 4);
});

test("reconcileYearEnd resets ytdOrdinaryInvestIncome to zero after 11 months of accrual", () => {
  // Run 11 step() calls manually (months 0–10) to accumulate ordinary income, then verify
  // the accumulator is positive. step() triggers reconcileYearEnd at month 11 (the 12th call),
  // so stopping at 11 steps ensures the accumulator has not yet been reset.
  // Then call reconcileYearEnd directly to exercise the reset path — previously untested.
  const s = makeScenario({
    horizonMonths: 12,
    monthlyIncome: 5_000,
    monthlyExpense: 5_000,
    composition: {
      equity:    { fraction: 0, expectedReturn: 0,    volPct: 0, ordinaryYield: 0,    qualifiedYield: 0 },
      bond:      { fraction: 1, expectedReturn: 0.04, volPct: 0, ordinaryYield: 0.04, qualifiedYield: 0 },
      ordIncome: { fraction: 0, expectedReturn: 0,    volPct: 0, ordinaryYield: 0,    qualifiedYield: 0 },
    },
  });
  const { composition } = resolveComposition(s);
  const state = initialState(s, composition);
  const sleeveReturns = { equity: 0, bond: 0.04 / 12, ordIncome: 0 };
  for (let m = 0; m < 11; m++) {
    step(state, [], s.events, s, { sleeveReturns }, composition);
  }
  // After 11 steps, accumulator must be positive (year-end reset happens at step 12).
  expect(state.ytdOrdinaryInvestIncome).toBeGreaterThan(0);
  // Now call reconcileYearEnd to exercise the reset path directly.
  reconcileYearEnd(state, s);
  expect(state.ytdOrdinaryInvestIncome).toBe(0);
});

test("TimelineRow includes per-sleeve balances when composition is set", () => {
  const s = makeScenario({
    horizonMonths: 1,
    monthlyIncome: 0,
    monthlyExpense: 0,
    composition: {
      equity:    { fraction: 0.5, expectedReturn: 0,    volPct: 0, ordinaryYield: 0, qualifiedYield: 0 },
      bond:      { fraction: 0.5, expectedReturn: 0,    volPct: 0, ordinaryYield: 0, qualifiedYield: 0 },
      ordIncome: { fraction: 0,   expectedReturn: 0,    volPct: 0, ordinaryYield: 0, qualifiedYield: 0 },
    },
  });
  const t = runDeterministic(s);
  const last = t.months.at(-1)!;
  expect(last.sleeves).toBeDefined();
  expect(last.sleeves!.equity).toBeCloseTo(50_000, 0);
  expect(last.sleeves!.bond).toBeCloseTo(50_000, 0);
  expect(last.sleeves!.ordIncome).toBe(0);
  // portfolioValue still emitted as the sum
  expect(last.portfolioValue).toBeCloseTo(100_000, 0);
});
