// Canonical category/subcategory string form. Every writer (API PATCH,
// the categories/merge endpoint, the LLM-driven Python aggregator) coerces
// to this shape so the Spending page's GROUP BY i.category collapses
// "Restaurants" + "restaurants" into one bucket.
//
// Mirrors emails/aggregate.py:_normalize on the Python side.
export function normalizeCategory(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function sameCategory(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeCategory(a) === normalizeCategory(b);
}

// Canonical Title Case STORAGE form for spending categories. Storage must use
// one form per category so the Spending page's `GROUP BY i.category` collapses
// variants into a single bucket. rules.yaml, the Python categorizer, migration
// 053, and spending.ts (`category != 'Transfer'`) all assume Title Case — so
// every writer (incl. the API PATCH + merge endpoints) must store this form,
// NOT normalizeCategory's lowercase. Mirrors canonical_category() in
// pipeline/src/finance_pipeline/categorize.py — keep the two in sync.
const CATEGORY_CANON: Record<string, string> = {
  // case-only normalization
  auto: "Auto", cash: "Cash", charity: "Charity", coffee: "Coffee",
  entertainment: "Entertainment", fees: "Fees", fitness: "Fitness",
  gas: "Gas", groceries: "Groceries", healthcare: "Healthcare",
  income: "Income", insurance: "Insurance", internet: "Internet",
  pets: "Pets", personal: "Personal", restaurants: "Restaurants",
  shopping: "Shopping", software: "Software", subscriptions: "Subscriptions",
  taxes: "Taxes", transfer: "Transfer", travel: "Travel",
  utilities: "Utilities", uncategorized: "Uncategorized",
  // legacy fine-grained → canonical bucket (matches migration 053)
  grocery: "Groceries", automotive: "Auto", vehicle: "Auto",
  transportation: "Auto", credit_interest: "Fees", investment_loss: "Fees",
  personal_care: "Personal", drinks: "Restaurants", snacks: "Restaurants",
  accessories: "Shopping", clothing: "Shopping", electronics: "Shopping",
  home_appliance: "Shopping", home_appliance_cleaning: "Shopping",
  home_decoration: "Shopping", home_furniture: "Shopping",
  home_hardware: "Shopping", home_lighting: "Shopping",
  home_renovation: "Shopping", labor: "Shopping", materials: "Shopping",
  mixed: "Shopping", outdoors: "Entertainment", debt_payment: "Transfer",
  travel_accessories: "Travel", unknown: "Uncategorized", crypto: "Transfer",
};

/** Coerce a category to its canonical Title Case storage form. Returns "" for
 *  empty input. Known case-variants/legacy aliases map via CATEGORY_CANON;
 *  anything else capitalizes the first letter (single-token default). */
export function canonicalCategory(s: string | null | undefined): string {
  const raw = (s ?? "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CATEGORY_CANON, key)) {
    return CATEGORY_CANON[key]!;
  }
  return raw[0]!.toUpperCase() + raw.slice(1).toLowerCase();
}

// Display form for the canonical value: underscores → spaces, each
// word title-cased ("home_appliance" → "Home Appliance"). Storage stays
// canonical; the UI calls this at every render site.
export function formatCategory(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
