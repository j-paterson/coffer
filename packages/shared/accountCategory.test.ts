// packages/shared/accountCategory.test.ts
import { test, expect } from "bun:test";
import {
  ACCOUNT_CATEGORIES,
  categoryMeta,
  signedBalance,
  isLiabilityType,
} from "./accountCategory";

test("every category maps to a valid engine type and group", () => {
  for (const c of ACCOUNT_CATEGORIES) {
    expect(typeof c.type).toBe("string");
    expect(["asset", "liability"]).toContain(c.group);
    expect(c.liability).toBe(c.group === "liability");
  }
});

test("asset categories keep the sign; liabilities negate", () => {
  expect(signedBalance("checking", 1000)).toBe(1000);
  expect(signedBalance("real_estate", 500000)).toBe(500000);
  expect(signedBalance("credit_card", 2000)).toBe(-2000);
  expect(signedBalance("loan", 270000)).toBe(-270000);
});

test("category metadata exposes adaptive balance labels", () => {
  expect(categoryMeta("checking").balanceLabel).toBe("Balance");
  expect(categoryMeta("loan").balanceLabel).toBe("Amount owed");
});

test("isLiabilityType recovers sign from a stored engine type", () => {
  expect(isLiabilityType("credit")).toBe(true);
  expect(isLiabilityType("manual")).toBe(true);
  expect(isLiabilityType("checking")).toBe(false);
  expect(isLiabilityType("alt")).toBe(false);
});
