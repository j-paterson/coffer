/** View-group layer — derived bundling for the accounts UI.
 *
 * Per-chain Zerion accounts (`zerion:base:0x…`, `zerion:ethereum:0x…`,
 * etc.) at the same address are kept as separate canonical accounts
 * because each chain holds different on-chain tokens (correct ledger
 * model). But to a human they're "one wallet."
 *
 * This layer computes, at query time, a `view_group_id` per canonical
 * account: typically `view_group_id = canonical_id`, but for an EVM
 * address with multiple per-chain canonicals, it becomes a synthetic
 * `wallet-group:<addr>`. The account-list endpoint emits one row per
 * view group; member rows roll up underneath.
 *
 * The data layer never sees view groups — they exist only in API
 * responses, derived from the accounts table on every request.
 */

import type { Ctx } from "../ctx";

export interface ViewGroupRow {
  account_id: string;       // canonical account_id (the actual row)
  canonical_id: string;     // = COALESCE(merged_into, id)
  view_group_id: string;    // bundling key (= canonical_id or wallet-group:addr)
  view_group_label: string; // display label for the bundle
  chain: string;            // for zerion accounts only — the chain this row is on
}

/** Build alias-id → view group metadata for every active account. */
export function computeViewGroups(ctx: Ctx): Map<string, ViewGroupRow> {
  const accounts = ctx.db
    .prepare(
      `SELECT id, COALESCE(merged_into, id) AS canonical,
              COALESCE(display_name_override, display_name) AS name
       FROM accounts WHERE active = 1`,
    )
    .all() as Array<{ id: string; canonical: string; name: string }>;

  // Per-address counts of distinct canonicals among zerion accounts.
  // A multi-chain wallet only earns a synthetic group if 2+ canonicals
  // exist at the same address — single-chain wallets stay un-bundled.
  const addrCanonicals = new Map<string, Set<string>>();
  for (const a of accounts) {
    if (!a.canonical.startsWith("zerion:")) continue;
    const parts = a.canonical.split(":", 3);
    if (parts.length !== 3) continue;
    const addr = parts[2].toLowerCase();
    if (!addrCanonicals.has(addr)) addrCanonicals.set(addr, new Set());
    addrCanonicals.get(addr)!.add(a.canonical);
  }
  const bundledAddrs = new Set(
    [...addrCanonicals.entries()]
      .filter(([, set]) => set.size >= 2)
      .map(([addr]) => addr),
  );

  // Pick a label per bundled address — the existing display name minus the
  // chain qualifier. Take the first one we see (any chain works since they
  // all share the wallet nickname for a multi-chain user).
  const labelByAddr = new Map<string, string>();
  for (const a of accounts) {
    if (!a.canonical.startsWith("zerion:")) continue;
    const parts = a.canonical.split(":", 3);
    if (parts.length !== 3) continue;
    const addr = parts[2].toLowerCase();
    if (!bundledAddrs.has(addr)) continue;
    if (!labelByAddr.has(addr)) {
      // "Ledger · Base" → "Ledger"; "Base 0x5160…8523" → "Wallet 0x5160…8523"
      let label = a.name.replace(/\s·\s.+$/, "").trim();
      if (/^[A-Z][a-z]+\s+0x/.test(label)) {
        // Names like "Base 0x5160…8523" — strip leading chain word.
        label = label.replace(/^[A-Z][a-z]+\s+/, "Wallet ");
      }
      labelByAddr.set(addr, label);
    }
  }

  const out = new Map<string, ViewGroupRow>();
  for (const a of accounts) {
    let view_group_id = a.canonical;
    let view_group_label: string | null = null;
    let chain = "";
    if (a.canonical.startsWith("zerion:")) {
      const parts = a.canonical.split(":", 3);
      if (parts.length === 3) {
        chain = parts[1];
        const addr = parts[2].toLowerCase();
        if (bundledAddrs.has(addr)) {
          view_group_id = `wallet-group:${addr}`;
          view_group_label = labelByAddr.get(addr) ?? a.name;
        }
      }
    }
    out.set(a.id, {
      account_id: a.id,
      canonical_id: a.canonical,
      view_group_id,
      view_group_label: view_group_label ?? a.name,
      chain,
    });
  }
  return out;
}

/** Return the canonical members of a single view group (all rows whose
 * view_group_id matches). Used by holdings-history when called on a
 * synthetic wallet-group: id. */
export function membersOfViewGroup(ctx: Ctx, groupId: string): string[] {
  if (!groupId.startsWith("wallet-group:")) return [];
  const addr = groupId.slice("wallet-group:".length);
  const rows = ctx.db
    .prepare(
      `SELECT id FROM accounts
       WHERE active = 1 AND id LIKE ? COLLATE NOCASE`,
    )
    .all(`zerion:%:${addr}`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
