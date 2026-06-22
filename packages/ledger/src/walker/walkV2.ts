/** Per-account v2 balance walker.
 *
 * Unified path — every canonical gets TWO values computed per date, and
 * the walker emits the max:
 *
 *   1. Postings-cumulative: walk postings + balance_assertions to a
 *      daily running balance. Assertions override; asset-only types
 *      clamp negatives. Covers bank accounts and anything where
 *      cashflow + periodic statement anchors define truth.
 *
 *   2. Mark-to-market: for each date, take the canonical's active sync
 *      session (from lib/cohort.ts) and sum position_snapshots at that
 *      session's (as_of, source). Disposed positions naturally drop out
 *      when a newer session supersedes the old one — no forward-fill,
 *      no phantom holdings. Covers crypto wallets where qty × price
 *      from direct on-chain data or exchange APIs is the truth.
 *
 * max(postings, mtm) per date wins. This captures the cases where:
 *   - Zerion's wallet-total chart (assertion) includes DeFi/LP that
 *     Alchemy can't enumerate → postings path wins.
 *   - Alchemy enumerates tokens Zerion filtered as spam → MTM path wins.
 *   - Bank checking has no MTM signal → postings path always wins.
 *
 * Used by holdings-history, wallet, and bundle endpoints.
 */

import type { LedgerCtx as Ctx } from "./ctx";
import { addDays } from "./dates";
import { DEFAULT_ASSET_ONLY_TYPES } from "./balanceWalk";
import { enabledSources, buildSessionTotalsCte } from "./cohort";

/** Walk one canonical account (rolling up any merged aliases). Returns
 * a date → balance map covering [earliestSignal, today]. Empty map if
 * no postings/assertions exist. */
function walkOneCanonical(
  ctx: Ctx,
  canonicalId: string,
  windowStart?: string,
  windowEnd?: string,
): Map<string, number> {
  return walkSeveralCanonicals(ctx, [canonicalId], windowStart, windowEnd).get(
    canonicalId,
  ) ?? new Map();
}

/** Walk several canonical accounts in one query pass — preferred when
 * summing across a wallet address or exchange bundle. */
export function walkSeveralCanonicals(
  ctx: Ctx,
  canonicalIds: string[],
  windowStart?: string,
  windowEnd?: string,
): Map<string, Map<string, number>> {
  if (canonicalIds.length === 0) return new Map();

  // Aliases (where merged_into points at any of these) plus the
  // canonicals themselves. Postings/assertions on either feed the same
  // canonical balance.
  const idSet = new Set(canonicalIds);
  const placeholders = canonicalIds.map(() => "?").join(",");
  const rawIds = ctx.db
    .prepare(
      `SELECT id, COALESCE(merged_into, id) AS canonical, type
       FROM accounts
       WHERE id IN (${placeholders})
          OR merged_into IN (${placeholders})`,
    )
    .all(...canonicalIds, ...canonicalIds) as Array<{
      id: string;
      canonical: string;
      type: string;
    }>;

  if (rawIds.length === 0) return new Map();
  const canonicalOf = new Map(rawIds.map((r) => [r.id, r.canonical]));
  const typeByCanonical = new Map<string, string>();
  for (const r of rawIds) {
    if (idSet.has(r.canonical) && !typeByCanonical.has(r.canonical)) {
      typeByCanonical.set(r.canonical, r.type);
    }
  }
  const allIds = rawIds.map((r) => r.id);
  const allPh = allIds.map(() => "?").join(",");

  // MTM path is computed for every canonical. Accounts without
  // position_snapshots yield empty MTM series and fall through to the
  // postings-cumulative path via max() below.
  const allCanonicalsForMtm = new Set(canonicalIds);

  // Always pull ALL postings/assertions — the cumulative sum at
  // `windowStart` depends on the entire prior history. We crop to the
  // requested window only when emitting the series.
  const postings = ctx.db
    .prepare(
      `SELECT p.account_id, t.date, SUM(p.amount) AS delta
       FROM postings p JOIN transactions_v2 t ON t.id = p.txn_id
       WHERE p.account_id IN (${allPh})
       GROUP BY p.account_id, t.date`,
    )
    .all(...allIds) as Array<{
      account_id: string;
      date: string;
      delta: number;
    }>;

  const deltasByCanonical = new Map<string, Map<string, number>>();
  for (const r of postings) {
    const canon = canonicalOf.get(r.account_id) ?? r.account_id;
    if (!deltasByCanonical.has(canon)) deltasByCanonical.set(canon, new Map());
    const m = deltasByCanonical.get(canon)!;
    m.set(r.date, (m.get(r.date) ?? 0) + r.delta);
  }

  // Only consider assertions from enabled sources, so toggling a source
  // off via `finance sources toggle` immediately removes those anchors
  // from the walk.
  const enabledAssertSources = enabledSources(ctx, "assertion");
  const assertSrcPh = enabledAssertSources.map(() => "?").join(",");
  const assertions = enabledAssertSources.length
    ? (ctx.db
        .prepare(
          `SELECT account_id, as_of, expected_usd
           FROM balance_assertions
           WHERE account_id IN (${allPh})
             AND source IN (${assertSrcPh})`,
        )
        .all(...allIds, ...enabledAssertSources) as Array<{
          account_id: string;
          as_of: string;
          expected_usd: number;
        }>)
    : [];
  const anchorsByCanonical = new Map<string, Map<string, number>>();
  for (const r of assertions) {
    const canon = canonicalOf.get(r.account_id) ?? r.account_id;
    if (!anchorsByCanonical.has(canon)) anchorsByCanonical.set(canon, new Map());
    anchorsByCanonical.get(canon)!.set(r.as_of, r.expected_usd);
  }

  const result = new Map<string, Map<string, number>>();
  // Default end-of-walk is today: postings-cumulative forward-fills
  // past the last signal exactly the way MTM forward-fills past its
  // last snapshot. Caller can pin a specific windowEnd; both paths
  // honor it. Walking to today (rather than "latest signal") keeps
  // manual-entry accounts (e.g. real-estate with only a periodic manual
  // balance_assertion) from dropping off the networth chart between
  // syncs and matches MTM's cutoff for consistency.
  let globalEnd = windowEnd ?? ctx.today;

  // Build the mark-to-market series for every canonical up front.
  // For each canonical, pull its sync sessions (one row per sync, each
  // with effective_from/effective_until) with the session's total
  // value — SUM(ps.value_usd) over the snapshots matching that
  // session's (as_of, source). On each date in [first_sync, cutoff],
  // the active session's total is the MTM value. Disposed positions
  // drop out naturally when a newer session supersedes the old one.
  const mtmSeriesByCanon = new Map<string, Map<string, number>>();
  if (allCanonicalsForMtm.size > 0) {
    const canonIds = Array.from(allCanonicalsForMtm);
    // session_totals pre-aggregates SUM(value_usd) per (canonical, as_of,
    // source) inside the CTE, so we skip the outer JOIN back to
    // position_snapshots. ~5x faster than cohort_sessions + groupby.
    const sessionRows = ctx.db
      .prepare(
        `WITH ${buildSessionTotalsCte(ctx, canonIds)}
         SELECT canonical_account, effective_from, effective_until, total
         FROM session_totals
         ORDER BY canonical_account, effective_from`,
      )
      .all() as Array<{
        canonical_account: string;
        effective_from: string;
        effective_until: string;
        total: number;
      }>;

    type Session = { from: string; until: string; total: number };
    const sessionsByCanon = new Map<string, Session[]>();
    for (const r of sessionRows) {
      let arr = sessionsByCanon.get(r.canonical_account);
      if (!arr) {
        arr = [];
        sessionsByCanon.set(r.canonical_account, arr);
      }
      arr.push({
        from: r.effective_from,
        until: r.effective_until,
        total: r.total,
      });
    }

    const cutoff = windowEnd ?? ctx.today;
    for (const canonical of allCanonicalsForMtm) {
      const sessions = sessionsByCanon.get(canonical);
      const series = new Map<string, number>();
      if (!sessions || sessions.length === 0) {
        mtmSeriesByCanon.set(canonical, series);
        continue;
      }
      // Monotonic cursor over the session list; advance past sessions
      // that have ended (until is exclusive). Sessions are contiguous
      // by construction of cohort_sessions, so once we're past the
      // first session.from there is always an active session until
      // we run out of data.
      let idx = 0;
      let cursor = sessions[0]!.from;
      while (cursor <= cutoff) {
        while (idx < sessions.length && sessions[idx]!.until <= cursor) idx++;
        if (idx >= sessions.length) break;
        const session = sessions[idx]!;
        if (
          session.from <= cursor &&
          (!windowStart || cursor >= windowStart)
        ) {
          series.set(cursor, session.total);
        }
        cursor = addDays(cursor, 1);
      }
      mtmSeriesByCanon.set(canonical, series);
    }
  }

  for (const canonical of canonicalIds) {
    const mtm = mtmSeriesByCanon.get(canonical) ?? new Map<string, number>();
    const deltas = deltasByCanonical.get(canonical);
    const anchors = anchorsByCanonical.get(canonical);

    // Build postings-cumulative series (same logic as before). If the
    // canonical has no postings+anchors signals, this series is empty.
    const postings = new Map<string, number>();
    if (deltas || anchors) {
      const signals = new Set<string>();
      if (deltas) for (const d of deltas.keys()) signals.add(d);
      if (anchors) for (const d of anchors.keys()) signals.add(d);
      const sorted = [...signals].sort();
      if (sorted.length > 0) {
      let cursor: string = sorted[0]!;
      let running = 0;
      const isAssetOnly = DEFAULT_ASSET_ONLY_TYPES.has(typeByCanonical.get(canonical) ?? "");
      while (cursor <= globalEnd) {
        if (anchors?.has(cursor)) running = anchors.get(cursor)!;
        else if (deltas?.has(cursor)) running += deltas.get(cursor) ?? 0;
        const stored = isAssetOnly && running < 0 ? 0 : running;
        if ((!windowStart || cursor >= windowStart) &&
            (!windowEnd || cursor <= windowEnd)) {
          postings.set(cursor, stored);
        }
        cursor = addDays(cursor, 1);
      }
      }
    }

    if (postings.size === 0 && mtm.size === 0) {
      result.set(canonical, new Map());
      continue;
    }

    // Combine postings and MTM per date:
    //
    //   - Crypto accounts → MTM ONLY. Postings for crypto exchanges
    //     record USD-denominated deposits/withdrawals, which drift
    //     arbitrarily from holdings (buy at $50K, token doubles →
    //     postings still $50K, MTM is $100K; sell → postings stay,
    //     MTM drops). Using max() in those cases inflated every
    //     Coinbase wallet's walked value by its cumulative USD flow.
    //
    //   - Non-crypto accounts → max(postings, mtm) when mtm > 0,
    //     otherwise postings as-is. MTM via Zerion-chart may under-
    //     count spam-filtered tokens; direct-on-chain sums may miss
    //     DeFi/LP — trust whichever is higher. When MTM is 0, fall
    //     through to postings (credit-card and mortgage negatives
    //     pass through intact).
    const series = new Map<string, number>();
    const accountType = typeByCanonical.get(canonical) ?? "";
    const isCrypto = accountType === "crypto";
    if (isCrypto) {
      for (const [d, mv] of mtm) series.set(d, mv);
    } else {
      const allDates = new Set<string>([...postings.keys(), ...mtm.keys()]);
      for (const d of allDates) {
        const pv = postings.get(d) ?? 0;
        const mv = mtm.get(d) ?? 0;
        series.set(d, mv > 0 ? Math.max(pv, mv) : pv);
      }
    }
    result.set(canonical, series);
  }
  return result;
}
