import { test, expect } from "bun:test";
import { makeRng, sampleNormal, sampleMonthlyLogReturn } from "../mc";

test("splitmix64 is deterministic for a given seed", () => {
  const a = makeRng(42n);
  const b = makeRng(42n);
  const as = Array.from({ length: 10 }, () => a.next());
  const bs = Array.from({ length: 10 }, () => b.next());
  expect(as).toEqual(bs);
});

test("splitmix64 produces different streams for different seeds", () => {
  const a = makeRng(1n);
  const b = makeRng(2n);
  expect(a.next()).not.toEqual(b.next());
});

test("sampleNormal has approximately zero mean and unit variance", () => {
  const rng = makeRng(123n);
  const n = 20_000;
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const z = sampleNormal(rng);
    sum += z;
    sumSq += z * z;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  expect(Math.abs(mean)).toBeLessThan(0.05);
  expect(Math.abs(variance - 1)).toBeLessThan(0.05);
});

test("sampleMonthlyLogReturn mean ≈ annual return over 12 months", () => {
  const rng = makeRng(7n);
  const annualReturn = 0.07;
  const annualVol = 0.15;
  const paths = 5000;
  let totalAnnualReturn = 0;
  for (let p = 0; p < paths; p++) {
    let v = 1;
    for (let m = 0; m < 12; m++) {
      v *= 1 + sampleMonthlyLogReturn(rng, annualReturn, annualVol);
    }
    totalAnnualReturn += v - 1;
  }
  const mean = totalAnnualReturn / paths;
  expect(Math.abs(mean - annualReturn)).toBeLessThan(0.01);
});

import { runWithMC } from "../engine";
import type { Scenario } from "../../../../../../packages/shared/types";

function basicScenario(): Scenario {
  return {
    startDate: "2026-01-01",
    horizonMonths: 60,
    baselineReturnPct: 0.07,
    baselineVolPct: 0.15,
    homeAppreciationPct: 0.03,
    mc: { enabled: true, paths: 1_000, seed: 42 },
    events: [],
    initialHomeValue: 500_000,
    initialPortfolioValue: 100_000,
    monthlyIncome: 10_000,
    monthlyExpense: 7_000,
    tax: {
      marginalOrdinaryRate: 0.32,
      ltcgRate: 0.238,
      qualifiedDivRate: 0.238,
      ltcgElection: false,
      ordinaryInvestmentIncomeMonthly: 0,
    },
  };
}

test("runWithMC returns percentile curves and is deterministic for fixed seed", () => {
  const s = basicScenario();
  const a = runWithMC(s);
  const b = runWithMC(s);
  expect(a.mc?.p50).toEqual(b.mc?.p50);
  expect(a.mc?.p10?.length).toBe(s.horizonMonths);
});

test("MC percentile curves are monotonic in percentile per month", () => {
  const t = runWithMC(basicScenario());
  const { p10, p25, p50, p75, p90 } = t.mc!;
  for (let m = 0; m < p50.length; m++) {
    expect(p10[m]).toBeLessThanOrEqual(p25[m]);
    expect(p25[m]).toBeLessThanOrEqual(p50[m]);
    expect(p50[m]).toBeLessThanOrEqual(p75[m]);
    expect(p75[m]).toBeLessThanOrEqual(p90[m]);
  }
});

test("mean of MC paths ≈ deterministic (within 2%)", () => {
  const s = basicScenario();
  s.mc.paths = 3_000;
  const mc = runWithMC(s);
  const det = runWithMC({ ...s, mc: { enabled: false, paths: 0 } });
  const mcFinal = mc.mc!.p50.at(-1)!;
  const detFinal = det.months.at(-1)!.netWorth;
  expect(Math.abs(mcFinal - detFinal) / Math.abs(detFinal)).toBeLessThan(0.02);
});
