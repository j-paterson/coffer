// packages/shared/categories.test.ts
import { test, expect } from "bun:test";
import { normalizeCategory, canonicalCategory, sameCategory } from "./categories";

test("normalizeCategory lowercases + underscores (comparison form)", () => {
  expect(normalizeCategory("Home Appliance")).toBe("home_appliance");
  expect(normalizeCategory("Restaurants")).toBe("restaurants");
  expect(normalizeCategory(null)).toBe("");
});

test("sameCategory compares case-insensitively", () => {
  expect(sameCategory("Restaurants", "restaurants")).toBe(true);
  expect(sameCategory("Gas", "Groceries")).toBe(false);
});

test("canonicalCategory returns Title Case storage form", () => {
  expect(canonicalCategory("restaurants")).toBe("Restaurants");
  expect(canonicalCategory("TRANSFER")).toBe("Transfer");
  expect(canonicalCategory("Shopping")).toBe("Shopping"); // stable
});

test("canonicalCategory maps legacy aliases to canonical buckets", () => {
  expect(canonicalCategory("grocery")).toBe("Groceries");
  expect(canonicalCategory("vehicle")).toBe("Auto");
  expect(canonicalCategory("debt_payment")).toBe("Transfer");
  expect(canonicalCategory("home_renovation")).toBe("Shopping");
});

test("canonicalCategory: empty stays empty, unknown capitalizes first letter", () => {
  expect(canonicalCategory("")).toBe("");
  expect(canonicalCategory("  ")).toBe("");
  expect(canonicalCategory(null)).toBe("");
  expect(canonicalCategory("widgets")).toBe("Widgets");
});

test("a UI-set Transfer now matches the spending query's Title-Case literal", () => {
  // Regression: normalizeCategory stored 'transfer' which never equalled the
  // spending.ts `category != 'Transfer'` filter, leaking transfers into spend.
  expect(canonicalCategory("transfer")).toBe("Transfer");
});
