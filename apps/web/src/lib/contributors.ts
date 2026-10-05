import type { HoldingsSnapshot } from "../../../../packages/shared/types";

export type Contributor = { label: string; delta: number };

export type RangeContributors = {
  top: Contributor[];
  /** Net change of every account not in `top`. */
  other: number;
  total: number;
};

/** The snapshot for `date`, or the latest one before it (an account with no
 *  row that day simply had no balance). Snapshots are sorted by as_of. */
function snapshotAt(snaps: HoldingsSnapshot[], date: string): HoldingsSnapshot | undefined {
  let found: HoldingsSnapshot | undefined;
  for (const s of snaps) {
    if (s.as_of > date) break;
    found = s;
  }
  return found;
}

/** Per-account change between two dates of the net worth breakdown, biggest
 *  movers (by absolute change) first. Mirrors the range callout's math:
 *  value at the end point minus value at the start point. */
export function rangeContributors(
  snaps: HoldingsSnapshot[],
  startDate: string,
  endDate: string,
  n = 5,
): RangeContributors | null {
  const start = snapshotAt(snaps, startDate);
  const end = snapshotAt(snaps, endDate);
  if (!end) return null;
  const deltas = new Map<string, number>();
  for (const h of end.holdings) deltas.set(h.symbol, h.value_usd);
  for (const h of start?.holdings ?? []) {
    deltas.set(h.symbol, (deltas.get(h.symbol) ?? 0) - h.value_usd);
  }
  const all = [...deltas.entries()]
    .map(([label, delta]) => ({ label, delta }))
    .filter((c) => Math.abs(c.delta) >= 0.005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = all.slice(0, n);
  const total = all.reduce((a, c) => a + c.delta, 0);
  const other = all.slice(n).reduce((a, c) => a + c.delta, 0);
  return { top, other, total };
}
