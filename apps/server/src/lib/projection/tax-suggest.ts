import type { Database } from "bun:sqlite";
import type { FilingStatus, TaxSuggestResponse } from "../../../../../packages/shared/types";

// 2025 federal tax year. Update annually when the IRS publishes adjustments.
// Brackets are the upper bounds of each rate tier; the final rate applies above
// the last threshold.

type Bracket = { upTo: number; rate: number };

const ORDINARY_BRACKETS: Record<FilingStatus, Bracket[]> = {
  single: [
    { upTo: 11_925, rate: 0.10 },
    { upTo: 48_475, rate: 0.12 },
    { upTo: 103_350, rate: 0.22 },
    { upTo: 197_300, rate: 0.24 },
    { upTo: 250_525, rate: 0.32 },
    { upTo: 626_350, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
  mfj: [
    { upTo: 23_850, rate: 0.10 },
    { upTo: 96_950, rate: 0.12 },
    { upTo: 206_700, rate: 0.22 },
    { upTo: 394_600, rate: 0.24 },
    { upTo: 501_050, rate: 0.32 },
    { upTo: 751_600, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
  hoh: [
    { upTo: 17_000, rate: 0.10 },
    { upTo: 64_850, rate: 0.12 },
    { upTo: 103_350, rate: 0.22 },
    { upTo: 197_300, rate: 0.24 },
    { upTo: 250_500, rate: 0.32 },
    { upTo: 626_350, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
};

const LTCG_BRACKETS: Record<FilingStatus, Bracket[]> = {
  single: [
    { upTo: 48_350, rate: 0.0 },
    { upTo: 533_400, rate: 0.15 },
    { upTo: Infinity, rate: 0.20 },
  ],
  mfj: [
    { upTo: 96_700, rate: 0.0 },
    { upTo: 600_050, rate: 0.15 },
    { upTo: Infinity, rate: 0.20 },
  ],
  hoh: [
    { upTo: 64_750, rate: 0.0 },
    { upTo: 566_700, rate: 0.15 },
    { upTo: Infinity, rate: 0.20 },
  ],
};

// Net Investment Income Tax: 3.8% surtax when MAGI exceeds the threshold.
const NIIT_RATE = 0.038;
const NIIT_THRESHOLD: Record<FilingStatus, number> = {
  single: 200_000,
  mfj: 250_000,
  hoh: 200_000,
};

function rateForBrackets(brackets: Bracket[], income: number): number {
  for (const b of brackets) {
    if (income <= b.upTo) return b.rate;
  }
  return brackets[brackets.length - 1].rate;
}

export function suggestTaxProfile(
  db: Database,
  opts: { filingStatus: FilingStatus; annualIncome?: number },
): TaxSuggestResponse {
  let annualIncome = opts.annualIncome;
  if (annualIncome === undefined) {
    const row = db
      .query<{ monthly_income: number | null }, []>(
        `SELECT monthly_income FROM cashflow_settings WHERE id = 1`,
      )
      .get();
    annualIncome = (row?.monthly_income ?? 0) * 12;
  }
  const marginal = rateForBrackets(ORDINARY_BRACKETS[opts.filingStatus], annualIncome);
  const ltcgBase = rateForBrackets(LTCG_BRACKETS[opts.filingStatus], annualIncome);
  const niitApplies = annualIncome > NIIT_THRESHOLD[opts.filingStatus];
  const ltcg = ltcgBase + (niitApplies ? NIIT_RATE : 0);
  return {
    filingStatus: opts.filingStatus,
    annualIncome,
    marginalOrdinaryRate: marginal,
    ltcgRate: ltcg,
    qualifiedDivRate: ltcg,
    niitApplies,
  };
}
