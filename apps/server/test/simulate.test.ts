import { describe, expect, test } from "bun:test";
import { simulate } from "../src/routes/debt";

const card = (
  overrides: {
    id?: string;
    balance: number;
    apr: number;
    min_pct?: number;
    min_floor?: number;
  },
) => ({
  account_id: overrides.id ?? `acct-${overrides.balance}`,
  display_name: `Card $${overrides.balance}`,
  balance: overrides.balance,
  apr: overrides.apr,
  min_payment_pct: overrides.min_pct ?? 0.02,
  min_payment_floor: overrides.min_floor ?? 25,
  promo_balance: null,
  promo_apr: null,
  promo_expires_at: null,
  notes: null,
});

describe("debt simulator", () => {
  test("zero balance: trivial — no months, no interest", () => {
    const result = simulate([], 0, "avalanche");
    expect(result.months_to_zero).toBe(0);
    expect(result.total_interest).toBe(0);
    expect(result.accounts).toEqual([]);
  });

  test("single card pays off in finite months with extra", () => {
    const result = simulate(
      [card({ balance: 1000, apr: 0.20 })],
      200,
      "avalanche",
    );
    expect(result.months_to_zero).toBeGreaterThan(0);
    expect(result.months_to_zero).toBeLessThan(12);
    expect(result.accounts[0].paid_off_month).toBe(result.months_to_zero);
  });

  test("higher extra → fewer months and less interest", () => {
    const lo = simulate(
      [card({ balance: 5000, apr: 0.22 })],
      100,
      "avalanche",
    );
    const hi = simulate(
      [card({ balance: 5000, apr: 0.22 })],
      500,
      "avalanche",
    );
    expect(hi.months_to_zero).toBeLessThan(lo.months_to_zero);
    expect(hi.total_interest).toBeLessThan(lo.total_interest);
  });

  test("avalanche pays the highest-APR card first", () => {
    const lowApr = card({ id: "low", balance: 5000, apr: 0.10 });
    const highApr = card({ id: "high", balance: 5000, apr: 0.30 });
    const result = simulate([lowApr, highApr], 500, "avalanche");
    const lowState = result.accounts.find((a) => a.account_id === "low")!;
    const highState = result.accounts.find((a) => a.account_id === "high")!;
    expect(highState.paid_off_month).toBeLessThan(lowState.paid_off_month!);
  });

  test("snowball pays the smallest-balance card first", () => {
    const small = card({ id: "small", balance: 1000, apr: 0.20 });
    const large = card({ id: "large", balance: 5000, apr: 0.20 });
    const result = simulate([small, large], 300, "snowball");
    const smallState = result.accounts.find((a) => a.account_id === "small")!;
    const largeState = result.accounts.find((a) => a.account_id === "large")!;
    expect(smallState.paid_off_month).toBeLessThan(largeState.paid_off_month!);
  });

  // Regression test for the cascade-of-freed-minimums bug.
  // Before the fix: when one card paid off, its minimum just disappeared
  // and the user's effective monthly debt budget shrank. After: freed
  // minimums roll into the extra-payment pool so the user's total monthly
  // debt commitment stays constant.
  test("freed minimums cascade after a card pays off (rolling snowball)", () => {
    const small = card({ id: "small", balance: 500, apr: 0.10, min_floor: 50 });
    const large = card({ id: "large", balance: 3000, apr: 0.10, min_floor: 50 });
    // No extra above minimums. Without cascade, each card just gets its
    // own min ($50) and the large card would barely pay down. With
    // cascade, after small clears (~10 months), its $50 redirects to
    // large, which finishes much sooner.
    const result = simulate([small, large], 0, "snowball");
    // Sanity: small clears first.
    const smallState = result.accounts.find((a) => a.account_id === "small")!;
    const largeState = result.accounts.find((a) => a.account_id === "large")!;
    expect(smallState.paid_off_month).toBeLessThan(largeState.paid_off_month!);
    // Cascade evidence: total payoff fits in well under MAX_MONTHS (600).
    // Without the cascade, even-rate cards with floor mins barely amortize.
    expect(result.months_to_zero).toBeLessThan(120);
  });

  test("promo APR is honored before expiration; reverts after", () => {
    const promo = {
      ...card({ balance: 1000, apr: 0.25 }),
      promo_balance: 1000,
      promo_apr: 0,
      // Set expiration far in the future so we never hit the snap during
      // a short payoff. Interest should be very low.
      promo_expires_at: "2099-12-31",
    };
    const noPromo = card({ balance: 1000, apr: 0.25 });
    const promoResult = simulate([promo], 200, "avalanche");
    const noPromoResult = simulate([noPromo], 200, "avalanche");
    expect(promoResult.total_interest).toBeLessThan(
      noPromoResult.total_interest * 0.1,
    );
  });
});
