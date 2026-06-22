/** Per-account recent-transaction list, v2.
 *
 * Source-of-truth: `postings` joined to `transactions_v2`. One group
 * per canonical account that has any non-pad postings; transactions
 * inside each group come from postings on aliases that roll up.
 *
 * Mirrors the v1 endpoint shape (TransactionRow[]) so the existing
 * web client doesn't need to change.
 */

import { Hono } from "hono";
import { attachReceipts } from "../lib/attachReceipts";
import type { Ctx } from "../ctx";
import { DEFAULT_ASSET_ONLY_TYPES } from "@coffer/ledger/walker";
import type {
  Account,
  AccountTransactionsGroup,
  TransactionRow,
} from "../../../../packages/shared/types";

const route = new Hono();

route.get("/by-account", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 20), 1),
    200,
  );

  // Per-canonical-account aggregate from postings. Pad transactions are
  // bookkeeping not real history; excluded from the count + sum so the
  // user sees actual activity.
  const aggregates = ctx.db
    .prepare(
      `
      SELECT
        canon.id, canon.display_name, canon.display_name_override,
        canon.institution, canon.type, canon.currency, canon.active,
        canon.mode,
        agg.cnt   AS count,
        agg.total AS sum,
        agg.earliest, agg.latest
      FROM accounts canon
      JOIN (
        SELECT COALESCE(a.merged_into, p.account_id) AS canonical,
               COUNT(*) AS cnt,
               SUM(p.amount) AS total,
               MIN(t.date) AS earliest,
               MAX(t.date) AS latest
        FROM postings p
        JOIN transactions_v2 t ON t.id = p.txn_id
        JOIN accounts a ON a.id = p.account_id
        WHERE p.account_id NOT LIKE 'equity:%'
        GROUP BY canonical
      ) agg ON agg.canonical = canon.id
      WHERE canon.id NOT LIKE 'equity:%' AND canon.merged_into IS NULL
      ORDER BY agg.latest DESC, canon.display_name
      `,
    )
    .all() as Array<
      Account & {
        count: number;
        sum: number;
        earliest: string | null;
        latest: string | null;
      }
    >;

  // Per-canonical recent txn pull: walk aliases too so a transaction on
  // any alias appears under the canonical row.
  const txnStmt = ctx.db.prepare(
    `
    SELECT CAST(t.id AS TEXT) AS id,
           p.account_id        AS account_id,
           t.date              AS date,
           p.amount            AS amount,
           t.description       AS description,
           NULL                AS merchant,
           NULL                AS subcategory,
           t.tags              AS tags,
           p.payee             AS payee,
           p.memo              AS memo,
           NULL                AS location_hint,
           NULL                AS bundle_id
    FROM postings p
    JOIN transactions_v2 t ON t.id = p.txn_id
    JOIN accounts a ON a.id = p.account_id
    WHERE COALESCE(a.merged_into, p.account_id) = ?
    ORDER BY t.date DESC, t.id DESC
    LIMIT ?
    `,
  );

  // Asset-only types: cumulative postings can drift negative from
  // unmatched outflows; clamp displayed balance like every other v2
  // endpoint does.
  const groups: AccountTransactionsGroup[] = aggregates.map((row) => {
    const { count, sum, earliest, latest, ...account } = row;
    const transactions = txnStmt.all(account.id, limit) as TransactionRow[];
    let bal = sum ?? 0;
    if (DEFAULT_ASSET_ONLY_TYPES.has(account.type) && bal < 0) bal = 0;
    account.latest_balance = bal;
    account.latest_as_of = latest;
    account.latest_source = "postings-v2";
    return {
      account: account as Account,
      count,
      sum: sum ?? 0,
      earliest,
      latest,
      transactions,
    };
  });

  const allTxns = groups.flatMap((g) => g.transactions);
  attachReceipts(ctx, allTxns);

  return c.json(groups);
});

export default route;
