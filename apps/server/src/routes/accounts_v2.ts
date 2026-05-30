/** Accounts listing with balances derived from double-entry postings.
 *
 * Equivalent to /api/accounts but reads `latest_balance` as the cumulative
 * sum of postings through today, rather than the most recent `balances`
 * row. Matches the net-worth v2 endpoint so everything the UI reads from
 * v2 is consistent with the postings ledger.
 *
 * Holdings still come from the v1 holdings table — that's orthogonal to
 * the double-entry refactor and doesn't need porting.
 */

import { Hono } from "hono";
import type { Ctx } from "../ctx";
import { computeViewGroups, membersOfViewGroup } from "../lib/viewGroups";
import { addDays, todayISO, buildCurrentCohortCte, buildCohortSessionsCte, COHORT_JOIN, walkSeveralCanonicals, breakdownByDate } from "@coffer/ledger/walker";
import type { Account, Holding } from "../../../../packages/shared/types";

const route = new Hono();

route.get("/", (c) => {
  // Only show canonical accounts in the listing — merged aliases are
  // hidden from the user but their postings still roll up. Inactive
  // canonicals are excluded: their historical postings lack a current
  // anchor and would appear as phantom balances (e.g. the legacy
  // CoinTracker bundle whose postings sum to >$1M but holds nothing).
  const ctx = c.get("ctx") as Ctx;
  const accounts = ctx.db
    .prepare(
      `
      SELECT id, display_name, display_name_override, institution,
             type, currency, active, mode
      FROM accounts
      WHERE id NOT LIKE 'equity:%' AND merged_into IS NULL AND active = 1
      ORDER BY mode ASC, institution, display_name
      `,
    )
    .all() as Array<Account>;
  if (accounts.length === 0) return c.json([]);

  const ids = accounts.map((a) => a.id);
  const placeholders = ids.map(() => "?").join(",");

  // Unified walk: per canonical, pick max(postings-cumulative, MTM-sum)
  // evaluated at today. Same walker the series endpoint uses — single
  // source of truth for every account's current balance.
  const today = todayISO();
  const walked = walkSeveralCanonicals(ctx, ids, undefined, today);
  const balanceById = new Map<string, { balance: number; as_of: string | null }>();
  for (const id of ids) {
    const series = walked.get(id);
    if (!series || series.size === 0) {
      balanceById.set(id, { balance: 0, as_of: null });
      continue;
    }
    let bestDate: string | null = null;
    for (const d of series.keys()) {
      if (d > today) continue;
      if (!bestDate || d > bestDate) bestDate = d;
    }
    balanceById.set(id, {
      balance: bestDate ? (series.get(bestDate) ?? 0) : 0,
      as_of: bestDate,
    });
  }

  // v2 positions: each (account, chain, contract, symbol) has stable
  // identity. Cohort CTE scopes each canonical account to its latest
  // sync (as_of, source) pair — disposed positions are naturally absent
  // from the cohort, no zero-row writes needed. See lib/cohort.ts.
  //
  // After cohort filtering, dedupe contract-empty siblings per
  // (canonical, chain, symbol) — legacy v1-backfilled rows that lack
  // on-chain identity get dropped when a contract-populated row exists.
  const holdings = ctx.db
    .prepare(
      `
      WITH ${buildCurrentCohortCte(ctx)},
      deduped AS (
        SELECT
          COALESCE(a.merged_into, p.account_id) AS canonical,
          p.symbol, p.chain, p.contract_address, p.asset_class,
          ps.quantity, ps.value_usd, ps.as_of, ps.source,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(a.merged_into, p.account_id), p.chain, p.symbol
            ORDER BY
              CASE WHEN p.contract_address = '' THEN 1 ELSE 0 END
          ) AS dedup_rn
        FROM positions p
        JOIN position_snapshots ps ON ps.position_id = p.id
        JOIN accounts a ON a.id = p.account_id
        ${COHORT_JOIN}
        WHERE COALESCE(a.merged_into, p.account_id) IN (${placeholders})
      )
      SELECT canonical, symbol, asset_class, quantity, value_usd, as_of,
             chain, contract_address, source
      FROM deduped
      WHERE dedup_rn = 1 AND value_usd > 0
      ORDER BY canonical, value_usd DESC
      `,
    )
    .all(...ids) as Array<
      Holding & {
        canonical: string;
        chain: string;
        contract_address: string;
        source: string;
      }
    >;
  // Same-symbol on different chains/contracts under one canonical account
  // are kept SEPARATE — they're distinct on-chain positions. The dropdown
  // labels them by symbol (with chain qualifier where helpful).
  const holdingsByAccount = new Map<string, Holding[]>();
  for (const h of holdings) {
    const { canonical, chain, contract_address, source, ...rest } = h;
    const label = chain ? `${rest.symbol} (${chain})` : rest.symbol;
    const display: Holding = { ...rest, symbol: label };
    if (!holdingsByAccount.has(canonical))
      holdingsByAccount.set(canonical, []);
    holdingsByAccount.get(canonical)!.push(display);
  }

  for (const a of accounts) {
    const hs = holdingsByAccount.get(a.id);
    if (hs && hs.length > 0) {
      a.holdings = hs.sort((x, y) => y.value_usd - x.value_usd);
    }
    const w = balanceById.get(a.id);
    a.latest_balance = w?.balance ?? 0;
    a.latest_as_of = w?.as_of ?? null;
    a.latest_source = "unified-walk";
  }

  // Apply the view-group layer: collapse multi-chain Zerion accounts at
  // the same address into one logical "wallet" row. Members keep their
  // own canonical_id in the data layer; this is a derived presentation.
  const viewGroups = computeViewGroups(ctx);
  const groupedByVG = new Map<string, Account[]>();
  for (const a of accounts) {
    const vg = viewGroups.get(a.id);
    const key = vg?.view_group_id ?? a.id;
    if (!groupedByVG.has(key)) groupedByVG.set(key, []);
    groupedByVG.get(key)!.push(a);
  }
  const collapsed: Account[] = [];
  for (const [vgKey, members] of groupedByVG) {
    if (members.length === 1) {
      collapsed.push(members[0]);
      continue;
    }
    // Multi-chain wallet bundle: synthesize one row.
    const vg = viewGroups.get(members[0].id)!;
    const total = members.reduce((s, m) => s + (m.latest_balance ?? 0), 0);
    const latestAsOf = members
      .map((m) => m.latest_as_of)
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    const allHoldings = members.flatMap((m) => m.holdings ?? []);
    allHoldings.sort((x, y) => y.value_usd - x.value_usd);
    collapsed.push({
      ...members[0],
      id: vgKey,
      display_name: vg.view_group_label,
      display_name_override: null,
      latest_balance: total,
      latest_as_of: latestAsOf,
      holdings: allHoldings,
    });
  }

  collapsed.sort((x, y) => {
    if (x.active !== y.active) return y.active - x.active;
    if (x.mode !== y.mode) return x.mode.localeCompare(y.mode);
    const xb = x.latest_balance ?? 0;
    const yb = y.latest_balance ?? 0;
    if (xb !== yb) return yb - xb;
    return (x.institution ?? "").localeCompare(y.institution ?? "");
  });

  return c.json(collapsed);
});

// Per-account daily history. Walks postings + assertions for the
// canonical account (rolling up any aliases); per-symbol holdings come
// from v2 position_snapshots with source-priority resolution per
// (position, date) so backfill data only fills gaps where no live
// observation exists.
route.get("/:id/holdings-history", (c) => {
  const id = c.req.param("id");
  // days=0 (or omitted with explicit ?days=all) returns full history.
  // Per-account chart should match what the net-worth chart aggregates,
  // which means honoring data back to the account's earliest signal.
  const daysParam = c.req.query("days") ?? "all";
  const daysNum = daysParam === "all" ? 0 : Number(daysParam);
  const windowStart =
    daysNum > 0 ? addDays(todayISO(), -daysNum) : undefined;

  const ctx = c.get("ctx") as Ctx;
  const groupMembers = membersOfViewGroup(ctx, id);
  const canonicals = groupMembers.length > 0 ? groupMembers : [id];
  const seriesByCanon = walkSeveralCanonicals(ctx, canonicals, windowStart);
  const series = new Map<string, number>();
  for (const m of seriesByCanon.values()) {
    for (const [d, v] of m) series.set(d, (series.get(d) ?? 0) + v);
  }

  // Alias ids for ALL canonicals in the group (including the canonicals
  // themselves), so positions on any member roll up to the group.
  const idPlaceholders = canonicals.map(() => "?").join(",");
  const aliases = ctx.db
    .prepare(
      `SELECT id FROM accounts
       WHERE id IN (${idPlaceholders}) OR merged_into IN (${idPlaceholders})`,
    )
    .all(...canonicals, ...canonicals) as Array<{ id: string }>;
  const aliasIds = aliases.map((a) => a.id);
  const placeholders = aliasIds.map(() => "?").join(",");

  // For each sync session in the cohort (one per canonical per sync date,
  // best source tie-break within a day), emit every snapshot that actually
  // matches (as_of, source). Disposed positions are naturally absent from
  // later sessions; stale backfill rows on dates the canonical wasn't
  // synced don't match any session and get filtered out. See lib/cohort.ts.
  const holdings = aliasIds.length
    ? (ctx.db
        .prepare(
          `
          WITH ${buildCohortSessionsCte(ctx)}
          SELECT ps.as_of, p.symbol, p.chain, ps.value_usd
          FROM positions p
          JOIN accounts a ON a.id = p.account_id
          JOIN position_snapshots ps ON ps.position_id = p.id
          JOIN cohort_sessions cs
            ON cs.canonical_account = COALESCE(a.merged_into, p.account_id)
           AND cs.as_of  = ps.as_of
           AND cs.source = ps.source
          WHERE p.account_id IN (${placeholders})
            ${windowStart ? "AND ps.as_of >= ?" : ""}
            AND ps.value_usd > 0
          `,
        )
        .all(
          ...aliasIds,
          ...(windowStart ? [windowStart] : []),
        ) as Array<{
          as_of: string;
          symbol: string;
          chain: string;
          value_usd: number;
        }>)
    : [];

  const holdingsByDate = new Map<
    string,
    { symbol: string; value_usd: number }[]
  >();
  for (const h of holdings) {
    if (!holdingsByDate.has(h.as_of)) holdingsByDate.set(h.as_of, []);
    const label = h.chain ? `${h.symbol} (${h.chain})` : h.symbol;
    holdingsByDate.get(h.as_of)!.push({ symbol: label, value_usd: h.value_usd });
  }

  const allDates = new Set<string>([
    ...series.keys(),
    ...holdingsByDate.keys(),
  ]);
  const snapshots = [...allDates]
    .map((as_of) => {
      const symbols = holdingsByDate.get(as_of) ?? [];
      const total = series.get(as_of) ??
        symbols.reduce((s, h) => s + h.value_usd, 0);
      return { as_of, total, holdings: symbols };
    })
    .sort((a, b) => a.as_of.localeCompare(b.as_of));

  return c.json({ snapshots });
});

// Combined daily history across every chain of one wallet address.
route.get("/wallets/:address/history", (c) => {
  const addr = c.req.param("address").toLowerCase();
  const daysParam = c.req.query("days") ?? "all";
  const daysNum = daysParam === "all" ? 0 : Number(daysParam);
  const windowStart =
    daysNum > 0 ? addDays(todayISO(), -daysNum) : undefined;
  const ctx = c.get("ctx") as Ctx;

  // Find every active account whose id ends with `:<addr>` (zerion per-chain).
  const ids = (ctx.db
    .prepare(
      `SELECT id FROM accounts
       WHERE active = 1 AND id LIKE 'zerion:%' AND lower(id) LIKE ?`,
    )
    .all(`zerion:%:${addr}`) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return c.json({ snapshots: [] });

  // Map to canonicals (some may be merged elsewhere).
  const rows = ctx.db
    .prepare(
      `SELECT COALESCE(merged_into, id) AS canonical
       FROM accounts WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{ canonical: string }>;
  const canonicals = [...new Set(rows.map((r) => r.canonical))];
  const seriesByCanon = walkSeveralCanonicals(ctx, canonicals, windowStart);

  // Per-symbol breakdown across every alias under those canonicals.
  // Previously pulled from the v1 `holdings` table which only covered
  // ~1 year — that was the grey tail on the chart. Now reads
  // position_snapshots with source-priority dedup so breakdowns go back
  // as far as alchemy-history reaches (often to 2017).
  const allAliasRows = ctx.db
    .prepare(
      `SELECT id FROM accounts
       WHERE id IN (${canonicals.map(() => "?").join(",")})
          OR merged_into IN (${canonicals.map(() => "?").join(",")})`,
    )
    .all(...canonicals, ...canonicals) as Array<{ id: string }>;
  const allAliases = allAliasRows.map((r) => r.id);
  const allDates = new Set<string>();
  for (const m of seriesByCanon.values()) for (const d of m.keys()) allDates.add(d);
  const holdingsByDate = breakdownByDate(ctx, allAliases, [...allDates]);

  const snapshots = [...allDates]
    .sort()
    .map((as_of) => {
      let total = 0;
      let hadSeries = false;
      for (const series of seriesByCanon.values()) {
        const v = series.get(as_of);
        if (v != null) {
          total += v;
          hadSeries = true;
        }
      }
      const symbols = holdingsByDate.get(as_of) ?? [];
      // Fall back to summing per-symbol holdings when the posting walker
      // has no data point for this date (or clamped to zero with no
      // anchor) — Zerion's per-symbol values are mark-to-market truth.
      if (!hadSeries || total === 0) {
        total = symbols.reduce((s, h) => s + h.value_usd, 0);
      }
      // If the walker knows a total but we have no per-token breakdown
      // for this date (wallet held DeFi/LPs Alchemy can't enumerate, or
      // pre-dates our on-chain history), surface the gap as a single
      // "Unidentified" slice rather than a blank stack. Keeps the chart
      // from showing a grey tail where we actually do know the total.
      const symbolsTotal = symbols.reduce((s, h) => s + h.value_usd, 0);
      const gap = total - symbolsTotal;
      const out =
        symbols.length === 0 && total > 0
          ? [{ symbol: "Unidentified", value_usd: total }]
          : gap > 1
            ? [...symbols, { symbol: "Unidentified", value_usd: gap }]
            : symbols;
      return { as_of, total, holdings: out };
    });

  return c.json({ snapshots });
});

// Combined daily history across every crypto sub-account at one
// institution (Coinbase, Kraken, etc.).
route.get("/bundle/:institution/history", (c) => {
  const inst = c.req.param("institution");
  const daysParam = c.req.query("days") ?? "all";
  const daysNum = daysParam === "all" ? 0 : Number(daysParam);
  const windowStart =
    daysNum > 0 ? addDays(todayISO(), -daysNum) : undefined;
  const ctx = c.get("ctx") as Ctx;

  const accts = ctx.db
    .prepare(
      `SELECT id, COALESCE(merged_into, id) AS canonical
       FROM accounts
       WHERE active = 1 AND mode = 'live' AND type = 'crypto'
         AND institution = ?`,
    )
    .all(inst) as Array<{ id: string; canonical: string }>;
  if (accts.length === 0) return c.json({ snapshots: [] });

  const canonicals = [...new Set(accts.map((a) => a.canonical))];
  const seriesByCanon = walkSeveralCanonicals(ctx, canonicals, windowStart);

  const allAliasRows = ctx.db
    .prepare(
      `SELECT id FROM accounts
       WHERE id IN (${canonicals.map(() => "?").join(",")})
          OR merged_into IN (${canonicals.map(() => "?").join(",")})`,
    )
    .all(...canonicals, ...canonicals) as Array<{ id: string }>;
  const allAliases = allAliasRows.map((r) => r.id);
  const allDates = new Set<string>();
  for (const m of seriesByCanon.values()) for (const d of m.keys()) allDates.add(d);
  const holdingsByDate = breakdownByDate(ctx, allAliases, [...allDates]);

  const snapshots = [...allDates].sort().map((as_of) => {
    let total = 0;
    let hadSeries = false;
    for (const series of seriesByCanon.values()) {
      const v = series.get(as_of);
      if (v != null) {
        total += v;
        hadSeries = true;
      }
    }
    const symbols = holdingsByDate.get(as_of) ?? [];
    if (!hadSeries || total === 0) {
      total = symbols.reduce((s, h) => s + h.value_usd, 0);
    }
    // Same "Unidentified" gap-fill as the per-wallet endpoint: if the
    // walker knows a total the per-token breakdown doesn't account for,
    // surface the gap as a labeled slice rather than leaving the chart
    // with a grey band.
    const symbolsTotal = symbols.reduce((s, h) => s + h.value_usd, 0);
    const gap = total - symbolsTotal;
    const out =
      symbols.length === 0 && total > 0
        ? [{ symbol: "Unidentified", value_usd: total }]
        : gap > 1
          ? [...symbols, { symbol: "Unidentified", value_usd: gap }]
          : symbols;
    return { as_of, total, holdings: out };
  });

  return c.json({ snapshots });
});

// GET /api/v2/accounts/wallets/:address/composition?date=YYYY-MM-DD
//
// For a multi-chain Zerion wallet at one address: at the given date,
// return the wallet's authoritative total (from zerion-chart assertions
// on-or-before the date), the sum of direct-token value (from
// alchemy-history snapshots), the residual (= total − direct), and the
// per-token breakdown. Positive residual = DeFi/LP value Alchemy can't
// enumerate. Negative residual is flagged: Zerion filtered something
// as spam; Alchemy is probably right.
route.get("/wallets/:address/composition", (c) => {
  const address = c.req.param("address").toLowerCase();
  const date = c.req.query("date") ?? todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "invalid date" }, 400);
  }
  const ctx = c.get("ctx") as Ctx;

  // All Zerion canonicals at this address (one per chain).
  const chains = ctx.db
    .prepare(
      `SELECT id, institution FROM accounts
       WHERE id LIKE 'zerion:%' AND active = 1
         AND LOWER(id) LIKE ?`,
    )
    .all(`zerion:%:${address}`) as Array<{ id: string; institution: string }>;

  const perChain: Array<{
    account_id: string;
    chain: string;
    zerion_total: number;
    zerion_anchor_date: string | null;
    alchemy_sum: number;
    residual: number;
    flag: "alchemy_exceeds_zerion" | null;
    positions: Array<{
      symbol: string;
      chain: string;
      contract_address: string;
      quantity: number;
      value_usd: number;
      as_of: string;
    }>;
  }> = [];

  for (const c0 of chains) {
    const [, chainName] = c0.id.split(":");

    // Latest zerion-chart assertion at-or-before date.
    const zRow = ctx.db
      .prepare(
        `SELECT as_of, expected_usd FROM balance_assertions
         WHERE account_id = ? AND source = 'zerion-chart' AND as_of <= ?
         ORDER BY as_of DESC LIMIT 1`,
      )
      .get(c0.id, date) as { as_of: string; expected_usd: number } | undefined;

    // Latest alchemy-history snapshot per position at-or-before date.
    const snaps = ctx.db
      .prepare(
        `SELECT p.symbol, p.chain, p.contract_address,
                ps.quantity, ps.value_usd, ps.as_of
         FROM positions p
         JOIN position_snapshots ps ON ps.position_id = p.id
         WHERE p.account_id = ? AND ps.source = 'alchemy-history'
           AND ps.as_of = (
             SELECT MAX(as_of) FROM position_snapshots
             WHERE position_id = p.id AND source = 'alchemy-history'
               AND as_of <= ?
           )
         ORDER BY ps.value_usd DESC`,
      )
      .all(c0.id, date) as Array<{
        symbol: string;
        chain: string;
        contract_address: string;
        quantity: number;
        value_usd: number;
        as_of: string;
      }>;

    const positions = snaps.filter((s) => s.value_usd > 0);
    const alchemy_sum = positions.reduce((s, p) => s + p.value_usd, 0);
    const zerion_total = zRow?.expected_usd ?? 0;
    const residual = zerion_total - alchemy_sum;
    const flag: "alchemy_exceeds_zerion" | null =
      residual < -50 ? "alchemy_exceeds_zerion" : null;

    perChain.push({
      account_id: c0.id,
      chain: chainName ?? "",
      zerion_total,
      zerion_anchor_date: zRow?.as_of ?? null,
      alchemy_sum,
      residual,
      flag,
      positions,
    });
  }

  const totals = perChain.reduce(
    (acc, r) => ({
      zerion_total: acc.zerion_total + r.zerion_total,
      alchemy_sum: acc.alchemy_sum + r.alchemy_sum,
      residual: acc.residual + r.residual,
    }),
    { zerion_total: 0, alchemy_sum: 0, residual: 0 },
  );

  return c.json({ address, date, per_chain: perChain, totals });
});

// PATCH /api/v2/accounts/:id — update display_name_override.
//
// `wallet-group:<addr>` is a synthetic id from the view-group layer —
// there's no row in `accounts` to update. Fan out to every per-chain
// member, writing "<name> · <Institution>" so computeViewGroups strips
// the chain suffix and reflects the new label on the bundle.
route.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ display_name_override?: string | null }>();
  const value =
    body.display_name_override == null
      ? null
      : body.display_name_override.trim() || null;
  const ctx = c.get("ctx") as Ctx;

  if (id.startsWith("wallet-group:")) {
    const members = ctx.db
      .prepare(
        `SELECT id, institution FROM accounts
         WHERE active = 1 AND id LIKE ? COLLATE NOCASE`,
      )
      .all(`zerion:%:${id.slice("wallet-group:".length)}`) as Array<{
        id: string;
        institution: string;
      }>;
    if (members.length === 0)
      return c.json({ error: "wallet group has no members" }, 404);
    const stmt = ctx.db.prepare(
      "UPDATE accounts SET display_name_override = ? WHERE id = ?",
    );
    for (const m of members) {
      const perChain = value == null ? null : `${value} · ${m.institution}`;
      stmt.run(perChain, m.id);
    }
    return c.json({ id, display_name_override: value });
  }

  const result = ctx.db
    .prepare("UPDATE accounts SET display_name_override = ? WHERE id = ?")
    .run(value, id);
  if (result.changes === 0) return c.json({ error: "account not found" }, 404);
  return c.json({ id, display_name_override: value });
});

export default route;
