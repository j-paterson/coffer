import { test, expect } from "bun:test";
import { groupEventsByMonth, validateTracing, type ActiveLoan, applyEvent } from "../events";
import type { ScenarioEvent } from "../../../../../../packages/shared/types";

test("groupEventsByMonth buckets events by atMonth preserving order", () => {
  const evs: ScenarioEvent[] = [
    { kind: "invest_cash", atMonth: 0, payload: { amount: 100, into: "baseline" } },
    { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 100, apr: 0.07, term_months: 360, rate_type: "variable", closing_costs: 0, traced_to_investment: true } },
    { kind: "rate_reset", atMonth: 24, payload: { loan_id: "L1", new_apr: 0.09 } },
  ];
  const g = groupEventsByMonth(evs);
  expect(g.get(0)?.length).toBe(2);
  expect(g.get(24)?.length).toBe(1);
  expect(g.get(0)?.[0].kind).toBe("invest_cash");
});

test("validateTracing returns warning if invest_cash references unknown loan", () => {
  const evs: ScenarioEvent[] = [
    { kind: "invest_cash", atMonth: 0, payload: { amount: 100, into: "baseline", funded_by_loan_id: "MISSING" } },
  ];
  const w = validateTracing(evs);
  expect(w.length).toBe(1);
  expect(w[0].kind).toBe("inconsistent_tracing");
});

test("validateTracing returns warning if loan is traced but no invest_cash references it", () => {
  const evs: ScenarioEvent[] = [
    { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 100, apr: 0.07, term_months: 360, rate_type: "fixed", closing_costs: 0, traced_to_investment: true } },
  ];
  const w = validateTracing(evs);
  expect(w.length).toBe(1);
  expect(w[0].kind).toBe("inconsistent_tracing");
});

test("applyEvent take_loan credits cashReserve and adds active loan", () => {
  const state = { cashReserve: 0, loans: new Map<string, ActiveLoan>() };
  applyEvent(
    { kind: "take_loan", atMonth: 0, payload: { loan_id: "L1", principal: 50_000, apr: 0.0725, term_months: 360, rate_type: "variable", closing_costs: 500, traced_to_investment: true } },
    state as any,
  );
  expect(state.cashReserve).toBe(49_500);
  expect(state.loans.get("L1")?.balance).toBe(50_000);
  expect(state.loans.get("L1")?.apr).toBe(0.0725);
});
