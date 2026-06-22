import type { Scenario, PortfolioComposition } from "../../../../../packages/shared/types";
import { runDeterministic } from "./engine";

/**
 * Find the return on the leveraged scenario's portfolio that makes its final
 * net worth equal the comparison scenario's final net worth.
 *
 * When `leveraged.composition` is set the bisection varies the `expectedReturn`
 * of every sleeve proportionally (keeping relative returns fixed) so that the
 * composition-driven engine path is exercised. When `composition` is absent the
 * legacy path varies `baselineReturnPct` only.
 *
 * Returns null if no crossing in [-0.10, +0.30].
 */
export function computeBreakEven(
  leveraged: Scenario,
  comparison: Scenario,
): number | null {
  const cmpFinal = runDeterministic(comparison).months.at(-1)!.netWorth;

  let f: (r: number) => number;

  if (leveraged.composition) {
    // Composition is set: vary all sleeve expectedReturns proportionally so the
    // engine uses the composition path rather than the baselineReturnPct fallback.
    // We treat `r` as the portfolio-level return and scale each sleeve's
    // expectedReturn by r / blended, where blended is the current weighted average.
    const c = leveraged.composition;
    const blended =
      c.equity.fraction    * c.equity.expectedReturn +
      c.bond.fraction      * c.bond.expectedReturn +
      c.ordIncome.fraction * c.ordIncome.expectedReturn;
    if (blended === 0) return null;

    const scaleComposition = (r: number): PortfolioComposition => {
      const scale = r / blended;
      return {
        equity:    { ...c.equity,    expectedReturn: c.equity.expectedReturn    * scale },
        bond:      { ...c.bond,      expectedReturn: c.bond.expectedReturn      * scale },
        ordIncome: { ...c.ordIncome, expectedReturn: c.ordIncome.expectedReturn * scale },
      };
    };

    f = (r: number) => {
      const s: Scenario = { ...leveraged, composition: scaleComposition(r) };
      return runDeterministic(s).months.at(-1)!.netWorth - cmpFinal;
    };
  } else {
    f = (r: number) => {
      const s = { ...leveraged, baselineReturnPct: r };
      return runDeterministic(s).months.at(-1)!.netWorth - cmpFinal;
    };
  }

  let lo = -0.10, hi = 0.30;
  const fLo = f(lo), fHi = f(hi);
  if (fLo * fHi > 0) return null;

  const tol = 0.0005;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < 1 || hi - lo < tol) return mid;
    if (fMid * fLo < 0) hi = mid;
    else {
      lo = mid;
    }
  }
  return (lo + hi) / 2;
}
