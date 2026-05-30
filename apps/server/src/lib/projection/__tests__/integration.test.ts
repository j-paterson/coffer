import { test, expect } from "bun:test";
import { run } from "..";
import type { Scenario } from "../../../../../../packages/shared/types";

const CANONICAL: Scenario = {
  startDate: "2026-01-01",
  horizonMonths: 360,
  baselineReturnPct: 0.065,
  baselineVolPct: 0.15,
  homeAppreciationPct: 0.03,
  mc: { enabled: false, paths: 0 },
  events: [
    { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 200_000, apr: 0.0725, term_months: 360, rate_type: "variable", closing_costs: 0, traced_to_investment: true } },
    { kind: "invest_cash", atMonth: 0, payload: { amount: 200_000, into: "baseline", funded_by_loan_id: "L1" } },
    { kind: "loan_payment_schedule", atMonth: 0, payload: { loan_id: "L1", from: "earned_income" } },
  ],
  initialHomeValue: 1_000_000,
  initialPortfolioValue: 500_000,
  monthlyIncome: 15_000,
  monthlyExpense: 9_000,
  tax: {
    marginalOrdinaryRate: 0.37,
    ltcgRate: 0.238,
    qualifiedDivRate: 0.238,
    ltcgElection: false,
    ordinaryInvestmentIncomeMonthly: 0,
  },
};

test("canonical scenario produces stable summary (snapshot)", () => {
  const compare: Scenario = { ...CANONICAL, events: [] };
  const { summary, timeline } = run(CANONICAL, compare);
  expect(timeline.months.length).toBe(360);
  expect(Math.round(summary.finalNetWorth)).toMatchSnapshot();
  expect(Math.round(summary.deltaVsBaseline)).toMatchSnapshot();
  expect(summary.breakEvenReturnPct == null ? null : Math.round(summary.breakEvenReturnPct * 10_000) / 10_000).toMatchSnapshot();
});

test("netWorseOffVsBaseline flagged in months where leveraged < comparison", () => {
  const leveraged = { ...CANONICAL, baselineReturnPct: 0.02 }; // below loan APR
  const comparison: Scenario = { ...CANONICAL, events: [] };
  const { timeline } = run(leveraged, comparison);
  expect(timeline.months.some((m) => m.netWorseOffVsBaseline)).toBe(true);
});
