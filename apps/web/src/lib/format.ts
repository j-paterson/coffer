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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // A bare YYYY-MM-DD is a calendar day. new Date() would read it as midnight UTC,
  // which renders as the previous day anywhere west of Greenwich.
  const m = DATE_ONLY.exec(iso);
  const d = m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** YYYY-MM-DD for the local calendar day (toISOString() gives the UTC day). */
export function localIsoDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
