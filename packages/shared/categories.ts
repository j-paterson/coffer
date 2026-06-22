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

// Display form for the canonical value: underscores → spaces, each
// word title-cased ("home_appliance" → "Home Appliance"). Storage stays
// canonical; the UI calls this at every render site.
export function formatCategory(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
