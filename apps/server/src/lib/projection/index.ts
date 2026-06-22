import type { Scenario, Timeline, ProjectionSummary } from "../../../../../packages/shared/types";
import { runDeterministic, runWithMC } from "./engine";
import { computeBreakEven } from "./breakeven";

export type RunResult = {
  timeline: Timeline;
  comparison?: Timeline;
  summary: ProjectionSummary;
};

export function run(scenario: Scenario, comparison?: Scenario): RunResult {
  const tline = scenario.mc.enabled ? runWithMC(scenario) : runDeterministic(scenario);
  const cmp = comparison ? runDeterministic(comparison) : undefined;

  if (cmp) {
    for (let i = 0; i < tline.months.length; i++) {
      const cmpNW = cmp.months[i]?.netWorth ?? 0;
      if (tline.months[i].netWorth < cmpNW) tline.months[i].netWorseOffVsBaseline = true;
    }
  }

  const finalNW = tline.months.at(-1)!.netWorth;
  const cmpFinal = cmp?.months.at(-1)?.netWorth ?? finalNW;
  const finalPortfolio = tline.months.at(-1)!.portfolioValue;
  const finalCost = scenario.events
    .filter((e) => e.kind === "invest_cash")
    .reduce((acc, e) => acc + (e as any).payload.amount, 0);
  const gains = Math.max(0, finalPortfolio - finalCost);
  const ltcgRate = scenario.tax.ltcgElection
    ? scenario.tax.marginalOrdinaryRate
    : scenario.tax.ltcgRate;
  const finalNetWorthAfterTaxIfLiquidated = finalNW - gains * ltcgRate;

  const firstUnder = tline.months.find((m) => m.underwaterOnHome)?.month;

  let mcSuccessProbability: number | undefined;
  if (tline.mc && cmp) {
    const pts = [tline.mc.p10, tline.mc.p25, tline.mc.p50, tline.mc.p75, tline.mc.p90];
    const above = pts.filter((p) => (p.at(-1) ?? 0) > cmpFinal).length;
    mcSuccessProbability = above / pts.length;
  }

  const breakEvenReturnPct = comparison ? computeBreakEven(scenario, comparison) : null;

  const summary: ProjectionSummary = {
    finalNetWorth: finalNW,
    finalNetWorthAfterTaxIfLiquidated,
    deltaVsBaseline: finalNW - cmpFinal,
    breakEvenReturnPct,
    firstMonthUnderwaterOnHome: firstUnder,
    mcSuccessProbability,
  };

  return { timeline: tline, comparison: cmp, summary };
}
