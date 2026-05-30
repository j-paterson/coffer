import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../../db/finance.sqlite");
export const db = new Database(DB_PATH, { readonly: true });

export type Kind = "snapshot" | "assertion";

export function getSourceRanks(kind: Kind): Map<string, { rank: number; enabled: boolean }> {
  const rows = db.prepare(
    "SELECT name, trust_rank, enabled FROM data_sources WHERE kind = ? ORDER BY trust_rank"
  ).all(kind) as Array<{ name: string; trust_rank: number; enabled: number }>;
  const m = new Map<string, { rank: number; enabled: boolean }>();
  for (const r of rows) m.set(r.name, { rank: r.trust_rank, enabled: !!r.enabled });
  return m;
}

export function enabledSources(kind: Kind): string[] {
  return (db.prepare(
    "SELECT name FROM data_sources WHERE kind = ? AND enabled = 1 ORDER BY trust_rank"
  ).all(kind) as Array<{ name: string }>).map(r => r.name);
}

export type SnapshotCandidate = {
  source: string;
  value_usd: number;
  quantity: number | null;
  as_of: string;
  rank: number;
  enabled: boolean;
};

/** For a given position and exact date, return all snapshot candidates
 * (enabled + disabled) ordered by effective rank. The highest-rank
 * *enabled* row is the winner used by walkV2. */
export function candidatesForPositionOnDate(positionId: number, asOf: string): SnapshotCandidate[] {
  const ranks = getSourceRanks("snapshot");
  const rows = db.prepare(
    `SELECT source, value_usd, quantity, as_of FROM position_snapshots
     WHERE position_id = ? AND as_of = ?`
  ).all(positionId, asOf) as Array<{ source: string; value_usd: number; quantity: number; as_of: string }>;
  const out: SnapshotCandidate[] = rows.map(r => {
    const meta = ranks.get(r.source);
    return {
      source: r.source,
      value_usd: r.value_usd,
      quantity: r.quantity,
      as_of: r.as_of,
      rank: meta?.rank ?? 999,
      enabled: meta?.enabled ?? false,
    };
  });
  // Lower rank = higher priority. Disabled → effectively 999.
  out.sort((a, b) => (a.enabled ? a.rank : 999) - (b.enabled ? b.rank : 999));
  return out;
}

/** Latest snapshot at-or-before `asOf` per position, respecting enabled
 * sources + rank. Mirrors walkV2's mark-to-market forward-fill. */
export function latestSnapshotAtOrBefore(positionId: number, asOf: string): SnapshotCandidate | null {
  const enabled = enabledSources("snapshot");
  if (enabled.length === 0) return null;
  const ph = enabled.map(() => "?").join(",");
  const ranks = getSourceRanks("snapshot");
  const rows = db.prepare(
    `SELECT source, value_usd, quantity, as_of FROM position_snapshots
     WHERE position_id = ? AND as_of <= ? AND source IN (${ph})
     ORDER BY as_of DESC`
  ).all(positionId, asOf, ...enabled) as Array<{ source: string; value_usd: number; quantity: number; as_of: string }>;
  if (rows.length === 0) return null;
  // Group by as_of desc; for the newest date, pick highest-trust.
  const newestDate = rows[0].as_of;
  const sameDate = rows.filter(r => r.as_of === newestDate);
  sameDate.sort((a, b) => (ranks.get(a.source)?.rank ?? 999) - (ranks.get(b.source)?.rank ?? 999));
  const w = sameDate[0];
  const meta = ranks.get(w.source);
  return { ...w, rank: meta?.rank ?? 999, enabled: meta?.enabled ?? false };
}

export const fmtUSD = (n: number): string => {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
};

export const fmtQty = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toPrecision(4);
};

export const pad = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);

export const padR = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
