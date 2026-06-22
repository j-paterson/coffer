/** Asset-only account types that can't legitimately hold a negative
 * USD balance — reconstructed negatives are always missing-data
 * artifacts and should clamp to zero. */
export const DEFAULT_ASSET_ONLY_TYPES = new Set([
  "crypto",
  "brokerage",
  "retirement",
  "alt",
  "real_estate",
  "savings",
]);
