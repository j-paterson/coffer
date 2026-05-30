/** Per-symbol chart breakdown, scoped to the active sync session on each date.
 *
 * The wallet and bundle history endpoints want a stacked per-date symbol
 * chart whose totals agree with the walker. For each date D we need the
 * holdings the canonical account actually held on D — which means the
 * snapshots from the sync session active on D, not whatever was last
 * seen per position.
 *
 * Per-position forward-fill (which we used to do here) phantoms disposed
 * positions: Zerion doesn't re-emit tokens you no longer hold, so the
 * last-seen value lingers until something else overwrites it. Cohort
 * sessions — from lib/cohort.ts — solve this by treating each sync as a
 * scope assertion that holds until the next sync supersedes it.
 *
 * Output dates without any active session on that date (before the
 * canonical's first sync) are omitted.
 */

import type { LedgerCtx as Ctx } from "./ctx";
import { buildCohortSessionsCte } from "./cohort";

export type BreakdownRow = { symbol: string; value_usd: number };

/** For each date in `dates`, return the per-symbol holdings sum across
 * `accountIds` (all aliases of whatever canonicals the caller cares about).
 * Values come from the active cohort session on that date. */
export function breakdownByDate(
  ctx: Ctx,
  accountIds: string[],
  dates: string[],
): Map<string, BreakdownRow[]> {
  if (accountIds.length === 0 || dates.length === 0) return new Map();

  const ph = accountIds.map(() => "?").join(",");

  // One row per (canonical, session, symbol) with the session's
  // effective_from/until range so we can map each date to its session.
  const rows = ctx.db.prepare(
    `WITH ${buildCohortSessionsCte(ctx)}
     SELECT cs.canonical_account, cs.effective_from, cs.effective_until,
            p.symbol, SUM(ps.value_usd) AS value_usd
     FROM positions p
     JOIN accounts a ON a.id = p.account_id
     JOIN cohort_sessions cs
       ON cs.canonical_account = COALESCE(a.merged_into, a.id)
     JOIN position_snapshots ps
       ON ps.position_id = p.id
      AND ps.as_of = cs.as_of
      AND ps.source = cs.source
     WHERE p.account_id IN (${ph})
       AND ps.value_usd > 0
     GROUP BY cs.canonical_account, cs.effective_from, cs.effective_until,
              p.symbol
     ORDER BY cs.canonical_account, cs.effective_from`,
  ).all(...accountIds) as Array<{
    canonical_account: string;
    effective_from: string;
    effective_until: string;
    symbol: string;
    value_usd: number;
  }>;

  type Session = { from: string; until: string; symbols: Map<string, number> };
  const byCanon = new Map<string, Session[]>();
  for (const r of rows) {
    let sessions = byCanon.get(r.canonical_account);
    if (!sessions) {
      sessions = [];
      byCanon.set(r.canonical_account, sessions);
    }
    let s = sessions[sessions.length - 1];
    if (!s || s.from !== r.effective_from) {
      s = { from: r.effective_from, until: r.effective_until, symbols: new Map() };
      sessions.push(s);
    }
    s.symbols.set(r.symbol, (s.symbols.get(r.symbol) ?? 0) + r.value_usd);
  }

  // Walk dates forward; per canonical keep a cursor into its sessions and
  // advance while the cursor's session has already ended (until <= d).
  // effective_until is exclusive, so session is active when from <= d < until.
  const sortedDates = [...dates].sort();
  const cursors = new Map<string, number>();
  for (const k of byCanon.keys()) cursors.set(k, 0);

  const out = new Map<string, BreakdownRow[]>();
  for (const d of sortedDates) {
    const perSymbol = new Map<string, number>();
    for (const [canon, sessions] of byCanon) {
      let idx = cursors.get(canon)!;
      while (idx < sessions.length && sessions[idx]!.until <= d) idx++;
      cursors.set(canon, idx);
      if (idx >= sessions.length) continue;
      const s = sessions[idx]!;
      if (s.from > d) continue;
      for (const [sym, v] of s.symbols) {
        perSymbol.set(sym, (perSymbol.get(sym) ?? 0) + v);
      }
    }
    if (perSymbol.size === 0) continue;
    out.set(d, [...perSymbol.entries()].map(([symbol, value_usd]) => ({ symbol, value_usd })));
  }
  return out;
}
