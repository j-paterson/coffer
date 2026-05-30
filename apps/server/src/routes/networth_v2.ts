/** Net-worth series / breakdown computed directly from double-entry
 * postings. No walker, no filter for transfer pairs (transfers have
 * two real-account legs that cancel by construction), no clamp-to-zero.
 *
 * Balance assertions from `balance_assertions` are applied as authoritative
 * anchors — if cumulative postings disagree, the endpoint trusts the
 * assertion for that date and emits a reconciliation note (visible via
 * the sync-status banner).
 */

import { Hono } from "hono";
import type { Ctx } from "../ctx";
import { addDays, periodKey, type Granularity, walkSeveralCanonicals } from "@coffer/ledger/walker";
import { computeViewGroups } from "../lib/viewGroups";
import type { HoldingsSnapshot, NetWorthPoint } from "../../../../packages/shared/types";

const route = new Hono();

interface AccountMeta {
  id: string;
  type: string;
  canonical_id: string;
  display_name: string;
  display_name_override: string | null;
}

interface WalkResult {
  seriesByAcct: Map<string, Map<string, number>>;
  globalStart: string;
  globalEnd: string;
  accounts: AccountMeta[];
  typeByCanonical: Map<string, string>;
}

/** Build per-canonical-account daily balance series from postings + anchors.
 * Shared between /series and /breakdown so both views walk identically. */
function walk(ctx: Ctx): WalkResult | null {
  // Only active canonicals contribute. Inactive accounts (e.g. legacy
  // aggregator bundles with stale postings) have no current anchor and
  // would leak phantom balances into every date. Same filter as
  // /api/summary — the chart's right edge then matches the headline.
  //
  // Trade-off: history for accounts since deactivated gets dropped. If
  // we want to preserve those we'd need a `deactivated_at` field to
  // zero out after closure rather than a binary active flag.
  const accounts = ctx.db
    .prepare(
      `SELECT id, type, display_name, display_name_override,
              COALESCE(merged_into, id) AS canonical_id
       FROM accounts WHERE id NOT LIKE 'equity:%' AND active = 1`,
    )
    .all() as AccountMeta[];
  if (accounts.length === 0) return null;
  const typeByCanonical = new Map<string, string>();
  for (const a of accounts) {
    if (!typeByCanonical.has(a.canonical_id)) {
      typeByCanonical.set(a.canonical_id, a.type);
    }
  }

  // Single shared walker — same code path that powers the per-account,
  // wallet, and bundle endpoints. Unified rule: per canonical, take
  // max(postings-cumulative-with-anchors, MTM-snapshot-sum).
  const canonicalIds = [...new Set(accounts.map((a) => a.canonical_id))];
  const seriesByAcct = walkSeveralCanonicals(ctx, canonicalIds);

  let globalStart = "";
  let globalEnd = "";
  for (const m of seriesByAcct.values()) {
    for (const d of m.keys()) {
      if (!globalStart || d < globalStart) globalStart = d;
      if (!globalEnd || d > globalEnd) globalEnd = d;
    }
  }
  if (!globalStart || !globalEnd) return null;

  return { seriesByAcct, globalStart, globalEnd, accounts, typeByCanonical };
}

route.get("/series", (c) => {
  const granularity = (c.req.query("granularity") ?? "day") as Granularity;
  if (!["day", "week", "month", "year"].includes(granularity)) {
    return c.json({ error: "invalid granularity" }, 400);
  }
  const ctx = c.get("ctx") as Ctx;
  const w = walk(ctx);
  if (!w) return c.json([]);
  const { seriesByAcct, globalStart, globalEnd } = w;

  const daily: NetWorthPoint[] = [];
  let cursor = globalStart;
  while (cursor <= globalEnd) {
    let assets = 0;
    let debts = 0;
    for (const series of seriesByAcct.values()) {
      const v = series.get(cursor);
      if (v == null) continue;
      if (v > 0) assets += v;
      else debts += -v;
    }
    daily.push({
      date: cursor,
      net_worth: assets - debts,
      total_assets: assets,
      total_debts: debts,
    });
    cursor = addDays(cursor, 1);
  }

  if (granularity === "day") return c.json(daily);
  const byPeriod = new Map<string, NetWorthPoint>();
  for (const p of daily) byPeriod.set(periodKey(p.date, granularity), p);
  return c.json([...byPeriod.values()]);
});

route.get("/breakdown", (c) => {
  const granularity = (c.req.query("granularity") ?? "day") as Granularity;
  if (!["day", "week", "month", "year"].includes(granularity)) {
    return c.json({ error: "invalid granularity" }, 400);
  }
  const ctx = c.get("ctx") as Ctx;
  const w = walk(ctx);
  if (!w) return c.json({ snapshots: [] });
  const { seriesByAcct, globalStart, globalEnd, accounts, typeByCanonical } = w;

  // Bucket key = canonical_id. One row per real canonical account, so
  // every breakdown entry traces to an account in /api/v2/accounts.
  // Display name comes from the canonical account's row (its
  // display_name_override / display_name); aliases just contribute
  // value, they don't get their own row.
  //
  // If the user wants per-chain Zerion wallets bundled under one wallet
  // identity, that's done via accounts.merged_into — not by string
  // munging — so the breakdown stays 1:1 with the accounts list.
  const nameOf = (a: AccountMeta) => a.display_name_override ?? a.display_name;
  // Apply view-group layer: per-chain Zerion accounts at the same
  // address bundle into a single wallet row in breakdown too, so the
  // chart matches the accounts list 1:1.
  const viewGroups = computeViewGroups(ctx);
  // canonical_id → bucket key (view_group_id) and label
  const bucketByCanonical = new Map<string, { key: string; label: string }>();
  for (const a of accounts) {
    const vg = viewGroups.get(a.id);
    if (vg) {
      bucketByCanonical.set(a.canonical_id, {
        key: vg.view_group_id,
        label: vg.view_group_label,
      });
    } else if (a.id === a.canonical_id) {
      bucketByCanonical.set(a.canonical_id, {
        key: a.canonical_id,
        label: nameOf(a),
      });
    }
  }

  const daily: HoldingsSnapshot[] = [];
  let cursor = globalStart;
  while (cursor <= globalEnd) {
    const buckets = new Map<string, number>();
    let total = 0;
    for (const [canonical, series] of seriesByAcct) {
      const v = series.get(cursor);
      if (v == null || v <= 0) continue;
      if (typeByCanonical.get(canonical) === "credit") continue;
      const bucket = bucketByCanonical.get(canonical);
      const label = bucket?.label ?? canonical;
      buckets.set(label, (buckets.get(label) ?? 0) + v);
      total += v;
    }
    const holdings = [...buckets.entries()]
      .map(([symbol, value_usd]) => ({ symbol, value_usd }))
      .sort((a, b) => b.value_usd - a.value_usd);
    daily.push({ as_of: cursor, total, holdings });
    cursor = addDays(cursor, 1);
  }

  if (granularity === "day") return c.json({ snapshots: daily });
  const byPeriod = new Map<string, HoldingsSnapshot>();
  for (const s of daily) byPeriod.set(periodKey(s.as_of, granularity), s);
  return c.json({ snapshots: [...byPeriod.values()] });
});

export default route;
