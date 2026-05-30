import type { EngineState } from "./events";

/**
 * Sum all sleeve balances to get the total portfolio value.
 */
export function sumSleeves(state: EngineState): number {
  return state.sleeves.equity + state.sleeves.bond + state.sleeves.ordIncome;
}

/**
 * Sell `amount` from sleeves using equity-first priority (equity → bond → ordIncome).
 * Returns the actual amount sold (may be less than requested if portfolio is exhausted).
 */
export function sellFromSleeves(state: EngineState, amount: number): number {
  let remaining = amount;
  const fromEquity = Math.min(remaining, state.sleeves.equity);
  state.sleeves.equity -= fromEquity;
  remaining -= fromEquity;
  const fromBond = Math.min(remaining, state.sleeves.bond);
  state.sleeves.bond -= fromBond;
  remaining -= fromBond;
  const fromOrd = Math.min(remaining, state.sleeves.ordIncome);
  state.sleeves.ordIncome -= fromOrd;
  return fromEquity + fromBond + fromOrd;
}
