// packages/shared/accountCategory.ts
import type { AccountType } from "./types";

/** User-facing account categories for manual accounts. */
export type AccountCategory =
  | "checking"
  | "savings"
  | "investment"
  | "retirement"
  | "real_estate"
  | "other_asset"
  | "credit_card"
  | "loan";

export interface CategoryMeta {
  id: AccountCategory;
  label: string;
  /** Engine account type this category maps to. */
  type: AccountType;
  group: "asset" | "liability";
  liability: boolean;
  /** Field label in the form ("Balance" vs "Amount owed"). */
  balanceLabel: string;
}

export const ACCOUNT_CATEGORIES: CategoryMeta[] = [
  { id: "checking",    label: "Checking",        type: "checking",   group: "asset",     liability: false, balanceLabel: "Balance" },
  { id: "savings",     label: "Savings",         type: "savings",    group: "asset",     liability: false, balanceLabel: "Balance" },
  { id: "investment",  label: "Investment",      type: "brokerage",  group: "asset",     liability: false, balanceLabel: "Balance" },
  { id: "retirement",  label: "Retirement",      type: "retirement", group: "asset",     liability: false, balanceLabel: "Balance" },
  { id: "real_estate", label: "Real estate",     type: "alt",        group: "asset",     liability: false, balanceLabel: "Value" },
  { id: "other_asset", label: "Other asset",     type: "alt",        group: "asset",     liability: false, balanceLabel: "Value" },
  { id: "credit_card", label: "Credit card",     type: "credit",     group: "liability", liability: true,  balanceLabel: "Amount owed" },
  { id: "loan",        label: "Loan / Mortgage", type: "manual",     group: "liability", liability: true,  balanceLabel: "Amount owed" },
];

const BY_ID = new Map(ACCOUNT_CATEGORIES.map((c) => [c.id, c]));

export function categoryMeta(id: AccountCategory): CategoryMeta {
  const meta = BY_ID.get(id);
  if (!meta) throw new Error(`unknown account category: ${id}`);
  return meta;
}

/** Convert a positive user-entered amount into the signed expected_usd
 *  for a balance assertion (liabilities are stored negative). */
export function signedBalance(category: AccountCategory, amount: number): number {
  return categoryMeta(category).liability ? -Math.abs(amount) : Math.abs(amount);
}

/** Recover the asset/liability sign from a stored engine type, for the
 *  balance-update endpoint (which only knows the account's type). Manual
 *  accounts created by this feature use `credit` and `manual` only for
 *  liabilities. */
export function isLiabilityType(type: AccountType | string): boolean {
  return type === "credit" || type === "manual";
}
