import type { ScenarioEvent, Warning, Scenario, PortfolioComposition } from "../../../../../packages/shared/types";
import { sellFromSleeves } from "./sleeves";

export type ActiveLoan = {
  loanId: string;
  balance: number;
  apr: number;
  rateType: "fixed" | "variable";
  termMonths: number;
  originMonth: number;
  tracedToInvestment: boolean;
  monthlyExtra: number;
  paymentFrom: "earned_income" | "portfolio";
};

export type ActiveShock = {
  remainingMonths: number;
  equityPct: number;
  homePct: number;
};

export type EngineState = {
  month: number;
  homeValue: number;
  cashReserve: number;
  // Authoritative portfolio representation. All portfolio mutations go through sleeves.
  sleeves: { equity: number; bond: number; ordIncome: number };
  loans: Map<string, ActiveLoan>;
  activeShock: ActiveShock | null;
  existingMortgageBalance: number;
  existingMortgagePayment: number;
  monthlyIncome: number;
  monthlyExpense: number;
  cumulativeInterestPaid: number;
  cumulativeTaxSaved: number;
  ytdInterestPaid: number; // only interest from traced loans
  ytdRealizedLTCG: number;
  ytdRealizedContributionsCost: number;
  taxCarryforward: number;
  forcedLiquidationThisMonth: boolean;
  // Accrued ordinary investment income this calendar year. Feeds the §163(d) NII cap
  // and is taxed at the marginal ordinary rate in reconcileYearEnd, then reset.
  ytdOrdinaryInvestIncome: number;
};

export function groupEventsByMonth(
  events: ScenarioEvent[],
): Map<number, ScenarioEvent[]> {
  const out = new Map<number, ScenarioEvent[]>();
  for (const ev of events) {
    const bucket = out.get(ev.atMonth) ?? [];
    bucket.push(ev);
    out.set(ev.atMonth, bucket);
  }
  return out;
}

export function validateTracing(events: ScenarioEvent[]): Warning[] {
  const warnings: Warning[] = [];
  const tracedLoanIds = new Set<string>();
  const investedLoanIds = new Set<string>();
  const knownLoanIds = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "take_loan") {
      knownLoanIds.add(ev.payload.loan_id);
      if (ev.payload.traced_to_investment) tracedLoanIds.add(ev.payload.loan_id);
    }
    if (ev.kind === "invest_cash" && ev.payload.funded_by_loan_id) {
      investedLoanIds.add(ev.payload.funded_by_loan_id);
      if (!knownLoanIds.has(ev.payload.funded_by_loan_id)) {
        warnings.push({
          kind: "inconsistent_tracing",
          message: `invest_cash references unknown loan '${ev.payload.funded_by_loan_id}'`,
          month: ev.atMonth,
        });
      }
    }
  }
  for (const id of tracedLoanIds) {
    if (!investedLoanIds.has(id)) {
      warnings.push({
        kind: "inconsistent_tracing",
        message: `Loan '${id}' is marked traced-to-investment but no invest_cash references it; interest will be treated as non-deductible.`,
      });
    }
  }
  return warnings;
}

export function loanIsDeductible(
  loan: ActiveLoan,
  events: ScenarioEvent[],
): boolean {
  if (!loan.tracedToInvestment) return false;
  return events.some(
    (e) => e.kind === "invest_cash" && e.payload.funded_by_loan_id === loan.loanId,
  );
}

const SLEEVE_FRACTION_TOLERANCE = 0.001;

export function resolveComposition(s: Scenario): {
  composition: PortfolioComposition;
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  if (!s.composition) {
    return {
      composition: {
        equity:    { fraction: 1, expectedReturn: s.baselineReturnPct, volPct: s.baselineVolPct, ordinaryYield: 0, qualifiedYield: 0 },
        bond:      { fraction: 0, expectedReturn: 0, volPct: 0, ordinaryYield: 0, qualifiedYield: 0 },
        ordIncome: { fraction: 0, expectedReturn: 0, volPct: 0, ordinaryYield: 0, qualifiedYield: 0 },
      },
      warnings,
    };
  }
  const c = s.composition;
  const sum = c.equity.fraction + c.bond.fraction + c.ordIncome.fraction;
  if (Math.abs(sum - 1) > SLEEVE_FRACTION_TOLERANCE) {
    warnings.push({
      kind: "composition_fractions_normalized",
      message: `Sleeve fractions summed to ${sum.toFixed(4)}; normalized to 1.0`,
    });
    if (sum === 0) {
      // Degenerate input: fall back to 100% equity rather than divide by zero.
      return {
        composition: {
          equity:    { ...c.equity,    fraction: 1 },
          bond:      { ...c.bond,      fraction: 0 },
          ordIncome: { ...c.ordIncome, fraction: 0 },
        },
        warnings,
      };
    }
    return {
      composition: {
        equity:    { ...c.equity,    fraction: c.equity.fraction / sum },
        bond:      { ...c.bond,      fraction: c.bond.fraction / sum },
        ordIncome: { ...c.ordIncome, fraction: c.ordIncome.fraction / sum },
      },
      warnings,
    };
  }
  return { composition: c, warnings };
}

export function applyEvent(ev: ScenarioEvent, state: EngineState): void {
  switch (ev.kind) {
    case "take_loan": {
      const p = ev.payload;
      state.loans.set(p.loan_id, {
        loanId: p.loan_id,
        balance: p.principal,
        apr: p.apr,
        rateType: p.rate_type,
        termMonths: p.term_months,
        originMonth: ev.atMonth,
        tracedToInvestment: p.traced_to_investment,
        monthlyExtra: 0,
        paymentFrom: "earned_income",
      });
      state.cashReserve += p.principal - (p.closing_costs ?? 0);
      return;
    }
    case "invest_cash": {
      const p = ev.payload;
      const amt = Math.min(p.amount, Math.max(0, state.cashReserve));
      state.cashReserve -= amt;
      // Baseline convention: surplus/invested cash goes to the equity sleeve (Task 3+).
      // "into === baseline" is the only current target; ordIncome or bond routing is a follow-up.
      if (p.into === "baseline") state.sleeves.equity += amt;
      return;
    }
    case "loan_payment_schedule": {
      const p = ev.payload;
      const loan = state.loans.get(p.loan_id);
      if (!loan) return;
      loan.paymentFrom = p.from;
      loan.monthlyExtra = p.monthly_extra ?? 0;
      return;
    }
    case "rate_reset": {
      const p = ev.payload;
      const loan = state.loans.get(p.loan_id);
      if (loan) loan.apr = p.new_apr;
      return;
    }
    case "market_shock": {
      const p = ev.payload;
      state.activeShock = {
        remainingMonths: p.duration_months,
        equityPct: p.equity_drawdown_pct,
        homePct: p.home_drawdown_pct,
      };
      // Field is named "equity_drawdown" historically (single-sleeve era). For now, apply
      // the same drawdown uniformly to all three sleeves. Per-sleeve drawdowns are a follow-up.
      const factor = 1 - p.equity_drawdown_pct;
      state.sleeves.equity    *= factor;
      state.sleeves.bond      *= factor;
      state.sleeves.ordIncome *= factor;
      state.homeValue *= 1 - p.home_drawdown_pct;
      return;
    }
    case "liquidate": {
      const p = ev.payload;
      const total = state.sleeves.equity + state.sleeves.bond + state.sleeves.ordIncome;
      const amt =
        p.amount_or_pct.kind === "amount"
          ? p.amount_or_pct.value
          : total * p.amount_or_pct.value;
      // Sell priority: equity first, then bond, then ordIncome.
      const sold = sellFromSleeves(state, amt);
      state.ytdRealizedLTCG += sold;
      if (p.to === "payoff_loan") {
        let target: ActiveLoan | null = null;
        for (const l of state.loans.values()) {
          if (!target || l.balance > target.balance) target = l;
        }
        if (target) {
          const applied = Math.min(sold, target.balance);
          target.balance -= applied;
          state.cashReserve += sold - applied;
        } else {
          state.cashReserve += sold;
        }
      } else {
        state.cashReserve += sold;
      }
      return;
    }
    case "cashflow_override": {
      const p = ev.payload;
      if (p.monthly_income !== undefined) state.monthlyIncome = p.monthly_income;
      if (p.monthly_expense !== undefined) state.monthlyExpense = p.monthly_expense;
      return;
    }
  }
}
