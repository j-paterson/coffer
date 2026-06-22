const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatUsd(n: number | null | undefined, cents = false): string {
  if (n == null) return "—";
  return (cents ? USD_CENTS : USD).format(n);
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Format a crypto/asset quantity with adaptive decimal precision.
 * < 0.01  → 6 dp   (dust / tiny DeFi positions)
 * < 1     → 4 dp   (fractional but visible)
 * < 1000  → 2 dp   (normal range)
 * ≥ 1000  → 0 dp   (large round numbers like BTC sats or share counts)
 */
export function formatPct(n: number, dp = 1): string {
  return `${n.toFixed(dp)}%`;
}

export function formatQty(n: number): string {
  if (n < 0.01) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  if (n < 1000)
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
