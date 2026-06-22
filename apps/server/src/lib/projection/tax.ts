// Year-end tax reconciliation for debt-funded investing.
// Implements IRC §163(d) investment interest expense with NII cap, §163(d)(4)(B)
// LTCG/qualified-dividend inclusion election, and indefinite carryforwards.
// See spec: docs/superpowers/specs/2026-04-17-heloc-invest-sandbox-design.md §Tax model.

import type { EngineState } from "./events";
import type { Scenario } from "../../../../../packages/shared/types";

export function reconcileYearEnd(state: EngineState, scenario: Scenario): void {
  const tax = scenario.tax;
  const interestThisYear = state.ytdInterestPaid;
  // Combined NII for the §163(d) cap. Note: state.ytdOrdinaryInvestIncome
  // is portfolio-derived (taxed below at the marginal rate) while
  // tax.ordinaryInvestmentIncomeMonthly is assumed to be NET of tax —
  // callers are responsible for ensuring it does not double-count
  // income already tracked by portfolio sleeves.
  const ordinaryInvestIncome = state.ytdOrdinaryInvestIncome + tax.ordinaryInvestmentIncomeMonthly * 12;
  const realizedLTCG = state.ytdRealizedLTCG;

  const nii = ordinaryInvestIncome + (tax.ltcgElection ? realizedLTCG : 0);

  const deductionAvailable = interestThisYear + state.taxCarryforward;
  const deductionAllowed = Math.min(deductionAvailable, Math.max(0, nii));
  state.taxCarryforward = deductionAvailable - deductionAllowed;

  const taxSaved = deductionAllowed * tax.marginalOrdinaryRate;
  state.cashReserve += taxSaved;
  state.cumulativeTaxSaved += taxSaved;

  if (realizedLTCG > 0) {
    const rate = tax.ltcgElection ? tax.marginalOrdinaryRate : tax.ltcgRate;
    state.cashReserve -= realizedLTCG * rate;
  }

  // Tax the portfolio-derived ordinary income at the marginal rate.
  // The interest deduction above will partly refund this for bond-heavy portfolios with HELOC draws.
  // Must run BEFORE resetting ytdOrdinaryInvestIncome.
  state.cashReserve -= state.ytdOrdinaryInvestIncome * tax.marginalOrdinaryRate;

  state.ytdInterestPaid = 0;
  state.ytdRealizedLTCG = 0;
  state.ytdOrdinaryInvestIncome = 0;
}
