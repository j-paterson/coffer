// Cohort: the scope-assertion semantics of position_snapshots.
//
// A sync is a scope assertion, not a per-position fact. When Zerion (or any
// exhaustive-list source) syncs wallet W at time T, it's telling us "W holds
// exactly these assets right now." Any position_id of W without a snapshot
// row on (T, source) is implicitly zero. We store the positive half of that
// assertion — the negative half is recovered by restricting reads to the
// sync cohort.
//
// Without this, a position that got disposed lingers as "latest snapshot
// per position" because nothing ever writes over it (Zerion doesn't re-emit
// tokens you no longer hold). Phantom holdings result.
//
// Each canonical account has a sequence of sync sessions — one row per
// distinct (as_of, source) sync, with `effective_from` = as_of and
// `effective_until` = the next sync's as_of (or '9999-12-31' for the
// latest). At any query date D, the "active cohort" for a canonical is
// the session where effective_from <= D < effective_until. Positions
// absent from a session's (as_of, source) are naturally absent from the
// result on those dates — no zero-row writes needed.
//
// Current-state queries (= D is today) reduce to the last session per
// canonical, i.e. effective_until = '9999-12-31'. buildCurrentCohortCte()
// surfaces that as a `cohort(canonical_account, as_of, source)` binding
// so callers using COHORT_JOIN read like before.
//
// This module is the one place source priority is read from (via the
// `data_sources` table) so `finance sources toggle` propagates everywhere.

import type { LedgerCtx as Ctx } from "./ctx";

/** Build a SQL CASE expression ranking sources by data_sources.trust_rank.
 * Disabled sources get rank 999 which sorts them last. `kind` selects
 * 'snapshot' (positions) or 'assertion' (balances).
 *
 * Call-site note: the CASE references a bare `source` column. When your
 * query qualifies it (e.g. `ps.source`), do the substitution at the call
 * site — `sourceRankCase("snapshot").replace(/\bsource\b/, "ps.source")`. */
export function sourceRankCase(ctx: Ctx, kind: "snapshot" | "assertion"): string {
  const rows = ctx.db
    .prepare(
      `SELECT name, trust_rank, enabled FROM data_sources
       WHERE kind = ? ORDER BY trust_rank`,
    )
    .all(kind) as Array<{ name: string; trust_rank: number; enabled: number }>;
  const whens = rows
    .map((r) => `WHEN '${r.name.replace(/'/g, "''")}' THEN ${r.enabled ? r.trust_rank : 999}`)
    .join("\n        ");
  return `CASE source\n        ${whens}\n        ELSE 999\n      END`;
}

/** Source names currently enabled for the given kind. Use in `source IN (…)`
 * filters to drop disabled sources from the input entirely (belt-and-suspenders
 * alongside the rank 999 they'd get from sourceRankCase). */
export function enabledSources(ctx: Ctx, kind: "snapshot" | "assertion"): string[] {
  return (ctx.db
    .prepare(
      `SELECT name FROM data_sources
       WHERE kind = ? AND enabled = 1 ORDER BY trust_rank`,
    )
    .all(kind) as Array<{ name: string }>).map((r) => r.name);
}

/** Inline a list of SQLite string literals for splicing into a SQL IN(...).
 * Used where we can't bind parameters — e.g. when the CTE is reused across
 * multiple .prepare() sites. Source names are controlled identifiers from
 * `data_sources`, not user input, but we escape quotes defensively. */
function inlineStrings(xs: string[]): string {
  return xs.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
}

/** CTE binding: `cohort_sessions(canonical_account, as_of, source,
 * effective_from, effective_until)` — one row per sync per canonical.
 * Source priority comes from `data_sources`; disabled sources are filtered
 * out entirely. This is the building block for every cohort read.
 *
 * Usage (splice into a WITH chain):
 *
 *   `WITH ${buildCohortSessionsCte()}, other_cte AS (...) SELECT ...`
 *
 * To scope to a single date D (historical read), add to the JOIN:
 *
 *   JOIN cohort_sessions cs
 *     ON cs.canonical_account = COALESCE(a.merged_into, p.account_id)
 *    AND cs.effective_from <= :D AND cs.effective_until > :D
 *    AND cs.as_of = ps.as_of AND cs.source = ps.source
 *
 * For current-state reads, prefer buildCurrentCohortCte() + COHORT_JOIN
 * which wraps the same logic with effective_until = '9999-12-31'.
 *
 * Pass `canonicalIds` to scope the CTE to just those canonicals at the
 * DISTINCT layer — big perf win when you already know the canonicals
 * (avoids a global 10K+ row sessions build on every query). */
export function buildCohortSessionsCte(ctx: Ctx, canonicalIds?: string[]): string {
  const enabled = enabledSources(ctx, "snapshot");
  // No enabled snapshot sources is nonsensical but we don't want the query
  // to blow up — emit an always-false filter so sessions CTE is empty and
  // downstream joins return zero rows (correct: no data, no cohort).
  const sourceFilter = enabled.length
    ? `AND ps.source IN (${inlineStrings(enabled)})`
    : `AND 1 = 0`;
  const canonFilter = canonicalIds?.length
    ? `AND COALESCE(a.merged_into, p.account_id) IN (${inlineStrings(canonicalIds)})`
    : "";
  // rankCase references a plain `source` column — the DISTINCT subquery
  // aliases ps.source to `source`, so no rewrite needed.
  const rankCase = sourceRankCase(ctx, "snapshot");
  return /* sql */ `
    cohort_sessions AS (
      SELECT canonical_account, as_of, source,
             as_of AS effective_from,
             COALESCE(
               LEAD(as_of) OVER (
                 PARTITION BY canonical_account ORDER BY as_of
               ),
               '9999-12-31'
             ) AS effective_until
      FROM (
        SELECT canonical_account, as_of, source,
               ROW_NUMBER() OVER (
                 PARTITION BY canonical_account, as_of
                 ORDER BY ${rankCase}
               ) AS rn
          FROM (
            SELECT DISTINCT
              COALESCE(a.merged_into, p.account_id) AS canonical_account,
              ps.as_of, ps.source
            FROM positions p
            JOIN position_snapshots ps ON ps.position_id = p.id
            JOIN accounts a ON a.id = p.account_id
            WHERE a.active = 1 AND a.id NOT LIKE 'equity:%'
              ${sourceFilter}
              ${canonFilter}
          ) pairs
      ) ranked
      WHERE rn = 1
    )`;
}

/** CTE binding: `session_totals(canonical_account, as_of, source, total,
 * effective_from, effective_until)` — cohort sessions with the per-session
 * SUM(ps.value_usd) pre-aggregated. For MTM walks that just need one
 * scalar per session, this avoids the outer JOIN back to position_snapshots
 * and is ~5x faster for whole-portfolio queries.
 *
 * Pass `canonicalIds` to scope the aggregation to a subset (usually the
 * caller knows its canonicals). */
export function buildSessionTotalsCte(ctx: Ctx, canonicalIds?: string[]): string {
  const enabled = enabledSources(ctx, "snapshot");
  const sourceFilter = enabled.length
    ? `AND ps.source IN (${inlineStrings(enabled)})`
    : `AND 1 = 0`;
  const canonFilter = canonicalIds?.length
    ? `AND COALESCE(a.merged_into, p.account_id) IN (${inlineStrings(canonicalIds)})`
    : "";
  const rankCase = sourceRankCase(ctx, "snapshot");
  return /* sql */ `
    session_totals AS (
      SELECT canonical_account, as_of, source, total,
             as_of AS effective_from,
             COALESCE(
               LEAD(as_of) OVER (
                 PARTITION BY canonical_account ORDER BY as_of
               ),
               '9999-12-31'
             ) AS effective_until
      FROM (
        SELECT canonical_account, as_of, source, total,
               ROW_NUMBER() OVER (
                 PARTITION BY canonical_account, as_of
                 ORDER BY ${rankCase}
               ) AS rn
        FROM (
          SELECT COALESCE(a.merged_into, p.account_id) AS canonical_account,
                 ps.as_of, ps.source, SUM(ps.value_usd) AS total
          FROM positions p
          JOIN position_snapshots ps ON ps.position_id = p.id
          JOIN accounts a ON a.id = p.account_id
          WHERE a.active = 1 AND a.id NOT LIKE 'equity:%'
            ${sourceFilter}
            ${canonFilter}
          GROUP BY canonical_account, ps.as_of, ps.source
        ) agg
      ) ranked
      WHERE rn = 1
    )`;
}

/** CTE binding chain: `cohort_sessions` + `cohort(canonical_account, as_of,
 * source)` restricted to the current (open-ended) session per canonical.
 * Spliced into a WITH clause; caller joins via COHORT_JOIN. */
export function buildCurrentCohortCte(ctx: Ctx): string {
  return `${buildCohortSessionsCte(ctx)},
    cohort AS (
      SELECT canonical_account, as_of, source
      FROM cohort_sessions
      WHERE effective_until = '9999-12-31'
    )`;
}

/** Join clause for current-state queries using buildCurrentCohortCte(). */
export const COHORT_JOIN = /* sql */ `
  JOIN cohort c
    ON c.canonical_account = COALESCE(a.merged_into, p.account_id)
   AND c.as_of  = ps.as_of
   AND c.source = ps.source
`;
