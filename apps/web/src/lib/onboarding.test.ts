// apps/web/src/lib/onboarding.test.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { ONBOARDED_KEY, isOnboarded, markOnboarded, shouldOnboard } from "./onboarding";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

test("markOnboarded sets the flag and isOnboarded reads it", () => {
  expect(isOnboarded()).toBe(false);
  markOnboarded();
  expect(localStorage.getItem(ONBOARDED_KEY)).toBe("1");
  expect(isOnboarded()).toBe(true);
});

test("shouldOnboard: only when zero accounts, not onboarded, and not already on /welcome", () => {
  expect(shouldOnboard(0, false, "/")).toBe(true);
  expect(shouldOnboard(0, true, "/")).toBe(false);        // already onboarded
  expect(shouldOnboard(3, false, "/")).toBe(false);       // has accounts
  expect(shouldOnboard(0, false, "/welcome")).toBe(false); // already there
  expect(shouldOnboard(undefined, false, "/")).toBe(false); // summary not loaded
});
