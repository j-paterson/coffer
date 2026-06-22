import type {
  Scenario,
  Timeline,
  TimelineRow,
  Warning,
  ScenarioEvent,
  PortfolioComposition,
} from "../../../../../packages/shared/types";
import {
  type EngineState,
  type ActiveLoan,
  groupEventsByMonth,
  validateTracing,
  loanIsDeductible,
  applyEvent,
  resolveComposition,
} from "./events";
import { reconcileYearEnd } from "./tax";
import { makeRng, sampleMonthlyLogReturn } from "./mc";
import { sellFromSleeves, sumSleeves } from "./sleeves";

type SleeveReturns = { equity: number; bond: number; ordIncome: number };

type StepOpts = {
  sleeveReturns: SleeveReturns;
};

export function initialState(s: Scenario, composition: PortfolioComposition): EngineState {
  const total = s.initialPortfolioValue;
  return {
    month: 0,
    homeValue: s.initialHomeValue,
    cashReserve: 0,
    sleeves: {
      equity:    total * composition.equity.fraction,
      bond:      total * composition.bond.fraction,
      ordIncome: total * composition.ordIncome.fraction,
    },
    loans: new Map(),
    activeShock: null,
    existingMortgageBalance: s.existingMortgage?.balance ?? 0,
    existingMortgagePayment: s.existingMortgage?.monthlyPayment ?? 0,
    monthlyIncome: s.monthlyIncome,
    monthlyExpense: s.monthlyExpense,
    cumulativeInterestPaid: 0,
    cumulativeTaxSaved: 0,
    ytdInterestPaid: 0,
    ytdRealizedLTCG: 0,
    ytdRealizedContributionsCost: 0,
    taxCarryforward: 0,
    forcedLiquidationThisMonth: false,
    ytdOrdinaryInvestIncome: 0,
  };
}

function monthlyPaymentAt(loan: ActiveLoan): number {
  const r = loan.apr / 12;
  const n = Math.max(1, loan.termMonths);
  if (r === 0) return loan.balance / n + loan.monthlyExtra;
  return (loan.balance * (r * Math.pow(1 + r, n))) / (Math.pow(1 + r, n) - 1) + loan.monthlyExtra;
}


export function step(
  state: EngineState,
  eventsThisMonth: ScenarioEvent[],
  allEvents: ScenarioEvent[],
  scenario: Scenario,
  opts: StepOpts,
  composition: PortfolioComposition,
): TimelineRow {
  state.forcedLiquidationThisMonth = false;

  // 1. Apply events scheduled this month.
  // applyEvent mutates state.sleeves for invest_cash, market_shock, and liquidate.
  for (const ev of eventsThisMonth) applyEvent(ev, state);

  // 2. Home appreciation (and lingering shock).
  if (state.activeShock && state.activeShock.remainingMonths > 0) {
    state.activeShock.remainingMonths -= 1;
    if (state.activeShock.remainingMonths === 0) state.activeShock = null;
  }
  state.homeValue *= 1 + scenario.homeAppreciationPct / 12;

  // 3. Accrue loan interest on every active loan.
  for (const loan of state.loans.values()) {
    const interest = loan.balance * (loan.apr / 12);
    loan.balance += interest;
    state.cumulativeInterestPaid += interest;
    if (loanIsDeductible(loan, allEvents)) state.ytdInterestPaid += interest;
  }
  if (state.existingMortgageBalance > 0) {
    const mortgageApr = scenario.existingMortgage?.apr ?? 0;
    const mortInt = state.existingMortgageBalance * (mortgageApr / 12);
    state.existingMortgageBalance += mortInt;
  }

  // 4. Pay loans.
  const freeCashflow = state.monthlyIncome - state.monthlyExpense;
  let cashAvail = freeCashflow;
  if (state.existingMortgageBalance > 0 && state.existingMortgagePayment > 0) {
    const pay = Math.min(state.existingMortgagePayment, state.existingMortgageBalance);
    cashAvail -= pay;
    state.existingMortgageBalance -= pay;
    if (state.existingMortgageBalance < 0) state.existingMortgageBalance = 0;
  }
  for (const loan of state.loans.values()) {
    if (loan.balance <= 0) continue;
    const payment = Math.min(monthlyPaymentAt(loan), loan.balance);
    if (loan.paymentFrom === "earned_income" && payment > cashAvail) {
      const shortfall = payment - Math.max(0, cashAvail);
      cashAvail = Math.min(cashAvail, 0);
      // Sell from sleeves equity-first to cover shortfall.
      // Amount actually sold may be less than shortfall if portfolio is exhausted — that's OK.
      sellFromSleeves(state, shortfall);
      state.forcedLiquidationThisMonth = true;
      loan.balance -= payment;
      if (loan.balance < 0) loan.balance = 0;
    } else if (loan.paymentFrom === "portfolio") {
      // Sell from sleeves equity-first to fund the payment.
      const sold = sellFromSleeves(state, payment);
      loan.balance -= sold;
      if (loan.balance < 0) loan.balance = 0;
    } else {
      cashAvail -= payment;
      loan.balance -= payment;
      if (loan.balance < 0) loan.balance = 0;
    }
  }

  // 4b. Reinvest any surplus earned income into the equity sleeve. Surplus that
  // isn't consumed by loan payments or expenses would realistically be invested at
  // the assumed return, not discarded. Both leveraged and baseline paths route surplus
  // the same way (to equity), so the comparison stays honest.
  // Baseline convention: surplus always routes to the equity sleeve.
  // scenario.surplusTarget (a follow-up field) could override this in the future.
  if (cashAvail > 0) {
    state.sleeves.equity += cashAvail;
    cashAvail = 0;
  }

  // 5a. Accrue ordinary investment income (before compound, on post-cashflow sleeve balances).
  // reconcileYearEnd consumes this for the §163(d) NII cap and taxes it at the marginal rate.
  const ordIncomeThisMonth =
      state.sleeves.equity    * composition.equity.ordinaryYield    / 12
    + state.sleeves.bond      * composition.bond.ordinaryYield      / 12
    + state.sleeves.ordIncome * composition.ordIncome.ordinaryYield / 12;
  state.ytdOrdinaryInvestIncome += ordIncomeThisMonth;

  // 5b. Per-sleeve compound. Each sleeve grows at its own monthly return.
  for (const k of ["equity", "bond", "ordIncome"] as const) {
    state.sleeves[k] *= 1 + opts.sleeveReturns[k];
    // Floor at 0: negative sleeve balances are not meaningful.
    if (state.sleeves[k] < 0) state.sleeves[k] = 0;
  }

  // 6. Year-end tax reconciliation.
  if (state.month % 12 === 11) {
    reconcileYearEnd(state, scenario);
  }

  // 7. Emit row.
  let loanBalance = 0;
  for (const l of state.loans.values()) loanBalance += l.balance;
  const homeEquity = state.homeValue - state.existingMortgageBalance;
  const portfolioTotal = sumSleeves(state);
  const netWorth =
    homeEquity + portfolioTotal + state.cashReserve - loanBalance;
  const underwaterOnHome =
    state.existingMortgageBalance + loanBalance > state.homeValue;

  const row: TimelineRow = {
    month: state.month,
    netWorth,
    homeEquity,
    portfolioValue: portfolioTotal,
    loanBalance,
    cumulativeInterestPaid: state.cumulativeInterestPaid,
    cumulativeTaxSaved: state.cumulativeTaxSaved,
    underwaterOnHome,
    netWorseOffVsBaseline: false,
    forcedLiquidation: state.forcedLiquidationThisMonth,
    sleeves: { ...state.sleeves },
  };

  state.month += 1;
  return row;
}

export function runDeterministic(scenario: Scenario): Timeline {
  const tracingWarnings: Warning[] = validateTracing(scenario.events);
  const { composition, warnings: compWarnings } = resolveComposition(scenario);
  const warnings: Warning[] = [...tracingWarnings, ...compWarnings];
  const grouped = groupEventsByMonth(scenario.events);
  const state = initialState(scenario, composition);
  const months: TimelineRow[] = [];
  // Deterministic monthly returns: each sleeve compounds at expectedReturn / 12.
  const sleeveReturns: SleeveReturns = {
    equity:    composition.equity.expectedReturn    / 12,
    bond:      composition.bond.expectedReturn      / 12,
    ordIncome: composition.ordIncome.expectedReturn / 12,
  };
  for (let m = 0; m < scenario.horizonMonths; m++) {
    const evs = grouped.get(m) ?? [];
    const row = step(state, evs, scenario.events, scenario, { sleeveReturns }, composition);
    months.push(row);
  }
  return { months, warnings };
}

export function runWithMC(scenario: Scenario): Timeline {
  if (!scenario.mc.enabled) return runDeterministic(scenario);

  const paths = Math.max(1, scenario.mc.paths);
  const baseSeed = BigInt(scenario.mc.seed ?? 1);
  const grouped = groupEventsByMonth(scenario.events);
  const tracingWarnings: Warning[] = validateTracing(scenario.events);
  const { composition, warnings: compWarnings } = resolveComposition(scenario);
  const warnings: Warning[] = [...tracingWarnings, ...compWarnings];

  const horizon = scenario.horizonMonths;
  const endValues: number[][] = Array.from({ length: horizon }, () => []);

  // Deterministic "center" run: used for the top-level months array.
  const center = runDeterministic(scenario);

  for (let p = 0; p < paths; p++) {
    const rng = makeRng(baseSeed + BigInt(p + 1));
    const state = initialState(scenario, composition);
    for (let m = 0; m < horizon; m++) {
      const evs = grouped.get(m) ?? [];
      // Sample independent log-normal returns per sleeve using each sleeve's own vol.
      // Correlation between sleeves = 0 (independent draws from rng). Correlation matrix
      // is a follow-up.
      const sleeveReturns: SleeveReturns = {
        equity:    sampleMonthlyLogReturn(rng, composition.equity.expectedReturn,    composition.equity.volPct),
        bond:      sampleMonthlyLogReturn(rng, composition.bond.expectedReturn,      composition.bond.volPct),
        ordIncome: sampleMonthlyLogReturn(rng, composition.ordIncome.expectedReturn, composition.ordIncome.volPct),
      };
      const row = step(state, evs, scenario.events, scenario, { sleeveReturns }, composition);
      endValues[m].push(row.netWorth);
    }
  }

  const mc = {
    p10: endValues.map((a) => percentile(a, 0.10)),
    p25: endValues.map((a) => percentile(a, 0.25)),
    p50: endValues.map((a) => percentile(a, 0.50)),
    p75: endValues.map((a) => percentile(a, 0.75)),
    p90: endValues.map((a) => percentile(a, 0.90)),
  };

  return { months: center.months, warnings, mc };
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}
