/** Portfolio views by canonical symbol.
 *
 * Reads the same `positions` + `position_snapshots` data as accounts_v2
 * but groups across accounts by canonical symbol (WETH+ETH+stETH → ETH).
 * The raw position data is never modified — canonicalization is purely
 * a derived view.
 *
 * Source-priority resolution kicks in per-position before the grouping
 * (same window function as the accounts dropdown), so a position seen by
 * multiple sources contributes once at the higher-trust value.
 */

import { Hono } from "hono";
import type { Ctx } from "../ctx";
import { buildCurrentCohortCte, COHORT_JOIN } from "@coffer/ledger/walker";
import { canonicalSymbol } from "../lib/symbolAliases";

const route = new Hono();

interface SymbolHolding {
  canonical_symbol: string;
  total_value_usd: number;
  total_quantity: number | null;
  positions: Array<{
    account_id: string;
    account_name: string;
    institution: string;
    raw_symbol: string;
    chain: string;
    contract_address: string;
    quantity: number | null;
    value_usd: number;
    source: string;
    as_of: string;
  }>;
}

route.get("/by-symbol", (c) => {
  const ctx = c.get("ctx") as Ctx;
  // Restrict to each canonical account's latest sync cohort so disposed
  // positions don't phantom-in via stale backfill snapshots. See
  // lib/cohort.ts.
  const rows = ctx.db
    .prepare(
      `
      WITH ${buildCurrentCohortCte(ctx)},
      deduped AS (
        SELECT
          COALESCE(a.merged_into, p.account_id) AS canonical_account,
          COALESCE(canon.display_name_override, canon.display_name) AS account_name,
          canon.institution,
          p.symbol, p.chain, p.contract_address,
          ps.quantity, ps.value_usd, ps.as_of, ps.source,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(a.merged_into, p.account_id), p.chain, p.symbol
            ORDER BY
              CASE WHEN p.contract_address = '' THEN 1 ELSE 0 END
          ) AS dedup_rn
        FROM positions p
        JOIN position_snapshots ps ON ps.position_id = p.id
        JOIN accounts a ON a.id = p.account_id
        JOIN accounts canon ON canon.id = COALESCE(a.merged_into, p.account_id)
        ${COHORT_JOIN}
        WHERE canon.active = 1 AND canon.id NOT LIKE 'equity:%'
      )
      SELECT canonical_account, account_name, institution, symbol,
             chain, contract_address, quantity, value_usd, as_of, source
      FROM deduped
      WHERE dedup_rn = 1 AND value_usd > 0
      `,
    )
    .all() as Array<{
      canonical_account: string;
      account_name: string;
      institution: string;
      symbol: string;
      chain: string;
      contract_address: string;
      quantity: number | null;
      value_usd: number;
      as_of: string;
      source: string;
    }>;

  // Group by canonical_symbol — derived layer, never persisted.
  const bySymbol = new Map<string, SymbolHolding>();
  for (const r of rows) {
    const canon = canonicalSymbol(r.symbol, r.chain, r.contract_address);
    let bucket = bySymbol.get(canon);
    if (!bucket) {
      bucket = {
        canonical_symbol: canon,
        total_value_usd: 0,
        total_quantity: null,
        positions: [],
      };
      bySymbol.set(canon, bucket);
    }
    bucket.total_value_usd += r.value_usd;
    if (r.quantity != null) {
      bucket.total_quantity = (bucket.total_quantity ?? 0) + r.quantity;
    }
    bucket.positions.push({
      account_id: r.canonical_account,
      account_name: r.account_name,
      institution: r.institution,
      raw_symbol: r.symbol,
      chain: r.chain,
      contract_address: r.contract_address,
      quantity: r.quantity,
      value_usd: r.value_usd,
      source: r.source,
      as_of: r.as_of,
    });
  }

  const out = [...bySymbol.values()]
    .map((s) => ({
      ...s,
      positions: s.positions.sort((a, b) => b.value_usd - a.value_usd),
    }))
    .sort((a, b) => b.total_value_usd - a.total_value_usd);

  return c.json(out);
});

export default route;
