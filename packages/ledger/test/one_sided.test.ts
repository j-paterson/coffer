import { describe, expect, test } from "bun:test";
import { oneSided, UNKNOWN_COUNTERPARTY } from "../src/gatekeepers/one_sided";

describe("oneSided", () => {
  test("returns a balanced posting pair", () => {
    const ps = oneSided("acct:checking", -42.5, { payee: "Comcast" });
    expect(ps).toHaveLength(2);
    const sum = ps.reduce((s, p) => s + p.amount, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-9);
  });

  test("first posting is the known account", () => {
    const ps = oneSided("acct:checking", 100);
    expect(ps[0]?.account_id).toBe("acct:checking");
    expect(ps[0]?.amount).toBe(100);
  });

  test("second posting is equity:unknown-counterparty with negated amount", () => {
    const ps = oneSided("acct:checking", 100);
    expect(ps[1]?.account_id).toBe(UNKNOWN_COUNTERPARTY);
    expect(ps[1]?.amount).toBe(-100);
  });

  test("propagates payee and memo to the known side only", () => {
    const ps = oneSided("acct:checking", -10, { payee: "X", memo: "m" });
    expect(ps[0]?.payee).toBe("X");
    expect(ps[0]?.memo).toBe("m");
    expect(ps[1]?.payee).toBeNull();
    expect(ps[1]?.memo).toBeNull();
  });
});
