/** TypeScript mirror of pipeline/tests/invariants.py — architectural
 *  invariants from ARCHITECTURE.md encoded as machine-checkable assertions
 *  over a bun:sqlite Database.
 *
 *  Each invariant is a function that takes a Database and throws InvariantError
 *  listing the offending rows when violated. ``runAll`` runs every invariant
 *  and surfaces the first failure.
 *
 *  Invariant catalogue:
 *    INV-1  every transactions_v2 row's postings sum to zero (per currency)
 *    INV-2  every posting.account_id references an existing accounts.id
 *    INV-3  every balance_assertion.source exists in data_sources(kind='assertion')
 *    INV-4  every position_snapshot.source exists in data_sources(kind='snapshot')
 *    INV-5  no accounts.merged_into cycle; chains terminate
 *    INV-6  data_sources.trust_rank unique within (kind, enabled=1)
 *    INV-7  every accounts row whose id starts 'equity:' has type='equity'
 *    INV-8  position_snapshots.value_usd ~= quantity * price_usd (1¢ tolerance, joined via asset_prices)
 */

import type { Database } from "bun:sqlite";

const TOLERANCE = 0.005; // dollars
const SNAPSHOT_TOLERANCE = 0.01; // dollars per row

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

export function INV_1_postingsBalance(db: Database): void {
  const rows = db.query(
    `SELECT txn_id, currency, ROUND(SUM(amount), 4) AS s
     FROM postings GROUP BY txn_id, currency
     HAVING ABS(s) > ?`,
  ).all(TOLERANCE) as Array<{ txn_id: number; currency: string; s: number }>;
  if (rows.length) {
    const details = rows
      .map((r) => `txn_id=${r.txn_id} ${r.currency}=${r.s >= 0 ? "+" : ""}${r.s.toFixed(4)}`)
      .join(", ");
    throw new InvariantError(`INV-1 postings balance violated: ${details}`);
  }
}

export function INV_2_postingAccountExists(db: Database): void {
  const rows = db.query(
    `SELECT p.id, p.account_id FROM postings p
     LEFT JOIN accounts a ON a.id = p.account_id
     WHERE a.id IS NULL`,
  ).all() as Array<{ id: number; account_id: string }>;
  if (rows.length) {
    const details = rows
      .map((r) => `posting=${r.id} account_id=${JSON.stringify(r.account_id)}`)
      .join(", ");
    throw new InvariantError(`INV-2 posting references unknown account: ${details}`);
  }
}

export function INV_3_assertionSourceKnown(db: Database): void {
  const rows = db.query(
    `SELECT DISTINCT ba.source FROM balance_assertions ba
     LEFT JOIN data_sources ds
       ON ds.name = ba.source AND ds.kind = 'assertion'
     WHERE ds.name IS NULL`,
  ).all() as Array<{ source: string }>;
  if (rows.length) {
    const details = rows.map((r) => JSON.stringify(r.source)).join(", ");
    throw new InvariantError(
      `INV-3 balance_assertion source not in data_sources(kind='assertion'): ${details}`,
    );
  }
}

export function INV_4_snapshotSourceKnown(db: Database): void {
  const rows = db.query(
    `SELECT DISTINCT ps.source FROM position_snapshots ps
     LEFT JOIN data_sources ds
       ON ds.name = ps.source AND ds.kind = 'snapshot'
     WHERE ds.name IS NULL`,
  ).all() as Array<{ source: string }>;
  if (rows.length) {
    const details = rows.map((r) => JSON.stringify(r.source)).join(", ");
    throw new InvariantError(
      `INV-4 position_snapshot source not in data_sources(kind='snapshot'): ${details}`,
    );
  }
}

export function INV_5_noMergeCycles(db: Database): void {
  const parentRows = db.query(
    "SELECT id, merged_into FROM accounts WHERE merged_into IS NOT NULL",
  ).all() as Array<{ id: string; merged_into: string }>;
  const parent: Record<string, string> = {};
  for (const r of parentRows) {
    parent[r.id] = r.merged_into;
  }
  for (const start of Object.keys(parent)) {
    const seen = new Set([start]);
    let cur: string | undefined = parent[start];
    while (cur !== undefined && cur in parent) {
      if (seen.has(cur)) {
        throw new InvariantError(
          `INV-5 merged_into cycle detected starting at ${JSON.stringify(start)}`,
        );
      }
      seen.add(cur);
      cur = parent[cur];
    }
  }
}

export function INV_6_trustRankUnique(db: Database): void {
  const rows = db.query(
    `SELECT kind, trust_rank, COUNT(*) c FROM data_sources
     WHERE enabled = 1
     GROUP BY kind, trust_rank HAVING c > 1`,
  ).all() as Array<{ kind: string; trust_rank: number; c: number }>;
  if (rows.length) {
    const details = rows
      .map((r) => `(${r.kind}, rank=${r.trust_rank}, count=${r.c})`)
      .join(", ");
    throw new InvariantError(
      `INV-6 trust_rank duplicated within enabled (kind, rank): ${details}`,
    );
  }
}

export function INV_7_equityAccountType(db: Database): void {
  const rows = db.query(
    `SELECT id, type FROM accounts
     WHERE id LIKE 'equity:%' AND type != 'equity'`,
  ).all() as Array<{ id: string; type: string }>;
  if (rows.length) {
    const details = rows
      .map((r) => `${JSON.stringify(r.id)} type=${JSON.stringify(r.type)}`)
      .join(", ");
    throw new InvariantError(`INV-7 equity:* account with non-equity type: ${details}`);
  }
}

export function INV_8_snapshotQtyPriceValue(db: Database): void {
  const rows = db.query(
    `SELECT ps.id, ps.quantity, ap.price_usd, ps.value_usd
     FROM position_snapshots ps
     JOIN positions pos ON pos.id = ps.position_id
     JOIN asset_prices ap
       ON ap.symbol = pos.symbol
      AND ap.as_of = ps.as_of
      AND ap.source = ps.source
      AND ap.chain = pos.chain
      AND ap.contract_address = pos.contract_address
     WHERE ps.quantity IS NOT NULL
       AND ABS(ps.value_usd - ps.quantity * ap.price_usd) > ?`,
  ).all(SNAPSHOT_TOLERANCE) as Array<{
    id: number; quantity: number; price_usd: number; value_usd: number;
  }>;
  if (rows.length) {
    const head = rows.slice(0, 5)
      .map((r) => `id=${r.id} qty=${r.quantity} price=${r.price_usd} value=${r.value_usd}`)
      .join(", ");
    const tail = rows.length > 5 ? ` (and ${rows.length - 5} more)` : "";
    throw new InvariantError(`INV-8 snapshot qty*price != value_usd: ${head}${tail}`);
  }
}

const ALL = [
  INV_1_postingsBalance,
  INV_2_postingAccountExists,
  INV_3_assertionSourceKnown,
  INV_4_snapshotSourceKnown,
  INV_5_noMergeCycles,
  INV_6_trustRankUnique,
  INV_7_equityAccountType,
  INV_8_snapshotQtyPriceValue,
];

/** Run every invariant. Throws on the first violation. */
export function runAll(db: Database): void {
  for (const fn of ALL) {
    fn(db);
  }
}
