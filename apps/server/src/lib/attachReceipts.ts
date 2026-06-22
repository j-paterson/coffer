import type { Ctx } from "../ctx";
import type {
  TransactionItem,
  TransactionReceipt,
  TransactionRow,
} from "../../../../packages/shared/types";

/**
 * Batch-load receipt metadata + line items for the given transactions and
 * splice them onto the TransactionRow objects in place. Used by both the
 * /transactions and /spending routes so the two pages render identical data.
 *
 * Post-migration-032 this keys off emails.transaction_v2_id /
 * transaction_items.transaction_v2_id. Incoming txn ids arrive as strings
 * (the v2 routes CAST(t.id AS TEXT)); SQLite coerces them back to INTEGER
 * for the comparison against the v2 FK column.
 */
export function attachReceipts(ctx: Ctx, txns: TransactionRow[]): void {
  if (txns.length === 0) return;
  const ids = txns.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");

  const receipts = ctx.db
    .prepare(
      `
      SELECT id AS email_id,
             CAST(transaction_v2_id AS TEXT) AS transaction_id,
             merchant, order_id, match_status
      FROM emails
      WHERE transaction_v2_id IN (${placeholders})
        AND match_status IN ('strict','fuzzy','uncertain')
      `,
    )
    .all(...ids) as Array<TransactionReceipt & { transaction_id: string }>;

  const items = ctx.db
    .prepare(
      `
      SELECT id,
             CAST(transaction_v2_id AS TEXT) AS transaction_id,
             name, short_name, quantity, unit_price,
             line_total, category, subcategory
      FROM transaction_items
      WHERE transaction_v2_id IN (${placeholders})
      ORDER BY transaction_v2_id, line_no
      `,
    )
    .all(...ids) as Array<TransactionItem & { transaction_id: string }>;

  const receiptByTxn = new Map<string, TransactionReceipt>();
  for (const r of receipts) {
    const { transaction_id, ...rest } = r;
    receiptByTxn.set(transaction_id, rest);
  }

  const itemsByTxn = new Map<string, TransactionItem[]>();
  for (const i of items) {
    const { transaction_id, ...rest } = i;
    if (!itemsByTxn.has(transaction_id)) itemsByTxn.set(transaction_id, []);
    itemsByTxn.get(transaction_id)!.push(rest);
  }

  for (const t of txns) {
    const r = receiptByTxn.get(t.id);
    if (r) t.receipt = r;
    const its = itemsByTxn.get(t.id);
    if (its && its.length > 0) t.items = its;
  }
}
