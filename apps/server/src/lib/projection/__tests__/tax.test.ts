import { test, expect } from "bun:test";
import { reconcileYearEnd } from "../tax";
import type { Scenario } from "../../../../../../packages/shared/types";
import type { EngineState } from "../events";

function makeState(partial: Partial<EngineState>): EngineState {
  return {
    month: 11,
    homeValue: 500_000,
    cashReserve: 0,
    sleeves: { equity: 100_000, bond: 0, ordIncome: 0 },
    loans: new Map(),
    activeShock: null,
    existingMortgageBalance: 0,
    existingMortgagePayment: 0,
    monthlyIncome: 0,
    monthlyExpense: 0,
    cumulativeInterestPaid: 0,
    cumulativeTaxSaved: 0,
    ytdInterestPaid: 0,
    ytdRealizedLTCG: 0,
    ytdRealizedContributionsCost: 0,
    taxCarryforward: 0,
    forcedLiquidationThisMonth: false,
    ytdOrdinaryInvestIncome: 0,
    ...partial,
  };
}

function makeScenario(tax: Partial<Scenario["tax"]> = {}): Scenario {
  return {
    startDate: "2026-01-01",
    horizonMonths: 12,
    baselineReturnPct: 0.07,
    baselineVolPct: 0.15,
    homeAppreciationPct: 0.03,
    mc: { enabled: false, paths: 0 },
    events: [],
    initialHomeValue: 500_000,
    initialPortfolioValue: 100_000,
    monthlyIncome: 0,
    monthlyExpense: 0,
    tax: {
      marginalOrdinaryRate: 0.32,
      ltcgRate: 0.238,
      qualifiedDivRate: 0.238,
      ltcgElection: false,
      ordinaryInvestmentIncomeMonthly: 0,
      ...tax,
    },
  };
}

test("no NII and no carryforward: deduction = 0; all interest becomes carryforward", () => {
  const state = makeState({ ytdInterestPaid: 5_000 });
  reconcileYearEnd(state, makeScenario({ ordinaryInvestmentIncomeMonthly: 0 }));
  expect(state.taxCarryforward).toBe(5_000);
  expect(state.cumulativeTaxSaved).toBe(0);
  expect(state.cashReserve).toBe(0);
});

test("NII > interest: full deduction, no carryforward, tax saved = interest * rate", () => {
  const state = makeState({ ytdInterestPaid: 4_000 });
  reconcileYearEnd(state, makeScenario({ ordinaryInvestmentIncomeMonthly: 500, marginalOrdinaryRate: 0.32 }));
  expect(state.taxCarryforward).toBe(0);
  expect(state.cumulativeTaxSaved).toBeCloseTo(1_280, 2);
  expect(state.cashReserve).toBeCloseTo(1_280, 2);
});

test("carryforward consumed by NII in a later year", () => {
  const s = makeScenario({ ordinaryInvestmentIncomeMonthly: 1_000, marginalOrdinaryRate: 0.30 });
  const state = makeState({ ytdInterestPaid: 0, taxCarryforward: 10_000 });
  reconcileYearEnd(state, s);
  expect(state.taxCarryforward).toBe(0);
  expect(state.cumulativeTaxSaved).toBeCloseTo(3_000, 2);
});

test("LTCG realized, no election: taxed at ltcg_rate; not in NII", () => {
  const s = makeScenario({ ltcgElection: false, ltcgRate: 0.238, ordinaryInvestmentIncomeMonthly: 0 });
  const state = makeState({ ytdRealizedLTCG: 10_000, ytdInterestPaid: 0 });
  reconcileYearEnd(state, s);
  expect(state.cashReserve).toBeCloseTo(-2_380, 2);
  expect(state.taxCarryforward).toBe(0);
});

test("LTCG realized with election: taxed at ordinary rate; counts toward NII so deduction is allowed", () => {
  const s = makeScenario({ ltcgElection: true, marginalOrdinaryRate: 0.37, ordinaryInvestmentIncomeMonthly: 0 });
  const state = makeState({ ytdRealizedLTCG: 10_000, ytdInterestPaid: 5_000 });
  reconcileYearEnd(state, s);
  expect(state.cumulativeTaxSaved).toBeCloseTo(1_850, 2);
  expect(state.cashReserve).toBeCloseTo(1_850 - 3_700, 2);
});

test("partial NII absorbs some interest; rest carries forward", () => {
  const s = makeScenario({ ordinaryInvestmentIncomeMonthly: 100, marginalOrdinaryRate: 0.30 });
  const state = makeState({ ytdInterestPaid: 5_000 });
  reconcileYearEnd(state, s);
  expect(state.taxCarryforward).toBeCloseTo(3_800, 2);
  expect(state.cumulativeTaxSaved).toBeCloseTo(360, 2);
});

test("ytd counters reset after reconciliation", () => {
  const state = makeState({
    ytdInterestPaid: 2_000,
    ytdRealizedLTCG: 1_000,
    ytdOrdinaryInvestIncome: 1_500, // NEW
  });
  reconcileYearEnd(state, makeScenario({ ordinaryInvestmentIncomeMonthly: 500 }));
  expect(state.ytdInterestPaid).toBe(0);
  expect(state.ytdRealizedLTCG).toBe(0);
  expect(state.ytdOrdinaryInvestIncome).toBe(0); // NEW
});

test("multi-year carryforward chain", () => {
  const s = makeScenario({ ordinaryInvestmentIncomeMonthly: 100, marginalOrdinaryRate: 0.30 });
  const state = makeState({ ytdInterestPaid: 5_000 });
  reconcileYearEnd(state, s);
  expect(state.taxCarryforward).toBeCloseTo(3_800, 2);
  state.ytdInterestPaid = 500;
  reconcileYearEnd(state, s);
  expect(state.taxCarryforward).toBeCloseTo(3_100, 2);
});

test("portfolio-derived ord income (ytdOrdinaryInvestIncome) feeds the NII cap", () => {
  const s = makeScenario({ marginalOrdinaryRate: 0.32, ordinaryInvestmentIncomeMonthly: 0 });
  const state = makeState({
    ytdInterestPaid: 5_000,
    ytdOrdinaryInvestIncome: 6_000, // bond sleeve generated $6k of ord income this year
  });
  reconcileYearEnd(state, s);
  // NII = 6_000, interest = 5_000, full deduction allowed
  // Tax saved = 5_000 * 0.32 = 1_600
  // Tax owed on ord income = 6_000 * 0.32 = 1_920
  // Net cashReserve change = 1_600 - 1_920 = -320
  expect(state.cumulativeTaxSaved).toBeCloseTo(1_600, 2);
  expect(state.cashReserve).toBeCloseTo(-320, 2);
  expect(state.taxCarryforward).toBe(0);
  expect(state.ytdOrdinaryInvestIncome).toBe(0); // reset
});

test("portfolio-derived ord income with no interest: taxed at marginal rate, no deduction", () => {
  const s = makeScenario({ marginalOrdinaryRate: 0.32, ordinaryInvestmentIncomeMonthly: 0 });
  const state = makeState({
    ytdInterestPaid: 0,
    taxCarryforward: 0,
    ytdOrdinaryInvestIncome: 4_000,
  });
  reconcileYearEnd(state, s);
  expect(state.taxCarryforward).toBe(0);
  expect(state.cumulativeTaxSaved).toBe(0);
  expect(state.cashReserve).toBeCloseTo(-1_280, 2); // 4000 * 0.32
  expect(state.ytdOrdinaryInvestIncome).toBe(0);
});

test("static ordinaryInvestmentIncomeMonthly still augments NII when no portfolio-derived income", () => {
  const s = makeScenario({ marginalOrdinaryRate: 0.30, ordinaryInvestmentIncomeMonthly: 1_000 });
  const state = makeState({ ytdInterestPaid: 0, ytdOrdinaryInvestIncome: 0, taxCarryforward: 10_000 });
  reconcileYearEnd(state, s);
  // NII = 0 + 12_000 = 12_000; carryforward = 10_000 fully consumed; tax saved = 10_000 * 0.30 = 3_000
  // No portfolio-derived income, so no ord-income tax bill
  expect(state.taxCarryforward).toBe(0);
  expect(state.cumulativeTaxSaved).toBeCloseTo(3_000, 2);
  expect(state.cashReserve).toBeCloseTo(3_000, 2); // tax savings, no ord-income tax
});
