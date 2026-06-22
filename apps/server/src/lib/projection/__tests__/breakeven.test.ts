import { test, expect } from "bun:test";
import { computeBreakEven } from "../breakeven";
import type { Scenario } from "../../../../../../packages/shared/types";

function baseScenario(): Scenario {
  return {
    startDate: "2026-01-01",
    horizonMonths: 120,
    baselineReturnPct: 0.07,
    baselineVolPct: 0.15,
    homeAppreciationPct: 0.03,
    mc: { enabled: false, paths: 0 },
    events: [
      { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 100_000, apr: 0.0725, term_months: 360, rate_type: "variable", closing_costs: 0, traced_to_investment: true } },
      { kind: "invest_cash", atMonth: 0, payload: { amount: 100_000, into: "baseline", funded_by_loan_id: "L1" } },
      { kind: "loan_payment_schedule", atMonth: 0, payload: { loan_id: "L1", from: "portfolio" } },
    ],
    initialHomeValue: 500_000,
    initialPortfolioValue: 100_000,
    monthlyIncome: 10_000,
    monthlyExpense: 5_000,
    tax: {
      marginalOrdinaryRate: 0.32,
      ltcgRate: 0.238,
      qualifiedDivRate: 0.238,
      ltcgElection: false,
      ordinaryInvestmentIncomeMonthly: 0,
    },
  };
}

test("break-even return is near gross APR, slightly below due to interest deductibility", () => {
  const s = baseScenario();
  const compare: Scenario = { ...s, events: [] };
  const be = computeBreakEven(s, compare);
  expect(be).not.toBeNull();
  expect(be!).toBeGreaterThanOrEqual(s.events[0].kind === "take_loan" ? 0.0725 - 0.002 : 0);
});

test("break-even is null when no crossing in [-10%, +30%]", () => {
  const s = baseScenario();
  const compare: Scenario = { ...s, events: [], initialPortfolioValue: 10_000_000 };
  const be = computeBreakEven(s, compare);
  expect(be).toBeNull();
});

test("break-even monotonicity: higher APR → higher break-even", () => {
  const s1 = baseScenario();
  const s2 = baseScenario();
  (s2.events[0] as any).payload.apr = 0.10;
  const compare = { ...s1, events: [] };
  const be1 = computeBreakEven(s1, compare)!;
  const be2 = computeBreakEven(s2, compare)!;
  expect(be2).toBeGreaterThan(be1);
});

test("break-even is finite when composition is set to 100% bond sleeve", () => {
  // When composition is explicitly set the bisection must vary sleeve returns,
  // not baselineReturnPct, to get a crossing. Verify the result is non-null and
  // plausible (below 7.25% APR × (1 − 0.24) + 25 bps tolerance = 0.0576).
  const s: Scenario = {
    startDate: "2026-01-01",
    horizonMonths: 120,
    baselineReturnPct: 0.05, // ignored when composition is set
    baselineVolPct: 0.05,
    homeAppreciationPct: 0.03,
    mc: { enabled: false, paths: 0 },
    events: [
      { kind: "take_loan", atMonth: 0, payload: { loan_id: "HELOC", principal: 200_000, apr: 0.0725, term_months: 360, rate_type: "variable", closing_costs: 0, traced_to_investment: true } },
      { kind: "invest_cash", atMonth: 0, payload: { amount: 200_000, into: "baseline", funded_by_loan_id: "HELOC" } },
      { kind: "loan_payment_schedule", atMonth: 0, payload: { loan_id: "HELOC", from: "earned_income" } },
    ],
    initialHomeValue: 500_000,
    initialPortfolioValue: 200_000,
    monthlyIncome: 10_000,
    monthlyExpense: 5_000,
    tax: {
      marginalOrdinaryRate: 0.24,
      ltcgRate: 0.15,
      qualifiedDivRate: 0.15,
      ltcgElection: false,
      ordinaryInvestmentIncomeMonthly: 0,
    },
    composition: {
      equity:    { fraction: 0, expectedReturn: 0.065, volPct: 0.15, ordinaryYield: 0.00, qualifiedYield: 0.02 },
      bond:      { fraction: 1, expectedReturn: 0.05,  volPct: 0.05, ordinaryYield: 0.05, qualifiedYield: 0.00 },
      ordIncome: { fraction: 0, expectedReturn: 0.050, volPct: 0.01, ordinaryYield: 0.05, qualifiedYield: 0.00 },
    },
  };
  const compare: Scenario = { ...s, events: [] };
  const be = computeBreakEven(s, compare);
  expect(be, `break-even should not be null with composition set`).not.toBeNull();
  expect(be!, `breakEven=${be}`).toBeGreaterThanOrEqual(0);
  expect(be!, `breakEven=${be} should be ≤ 0.0576`).toBeLessThanOrEqual(0.0725 * (1 - 0.24) + 0.0025);
});

test("break-even returns null when composition's blended return is zero", () => {
  const s = baseScenario();
  s.composition = {
    equity: { fraction: 1, expectedReturn: 0, volPct: 0.15, ordinaryYield: 0, qualifiedYield: 0 },
    bond: { fraction: 0, expectedReturn: 0, volPct: 0, ordinaryYield: 0, qualifiedYield: 0 },
    ordIncome: { fraction: 0, expectedReturn: 0, volPct: 0, ordinaryYield: 0, qualifiedYield: 0 },
  };
  const compare: Scenario = { ...s, events: [] };
  expect(computeBreakEven(s, compare)).toBeNull();
});
