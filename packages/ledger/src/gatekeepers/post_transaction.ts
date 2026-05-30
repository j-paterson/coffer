import type { Database } from "bun:sqlite";
import { LedgerError } from "./errors";
import type { Posting } from "./posting";

const TOLERANCE = 0.005; // dollars — rounding slack

export interface PostTransactionInput {
  date: string;
  description: string | null;
  postings: Posting[];
  raw_ids?: number[];
  derived_by?: string;
  category?: string | null;
  notes?: string | null;
}

/** Write a balanced transaction. Enforces SUM(amount)==0 per currency.
 *  Mirrors pipeline/src/finance_pipeline/ledger.py:post_transaction. */
export function postTransaction(db: Database, input: PostTransactionInput): number {
  const ps = input.postings;
  if (ps.length < 2) {
    throw new LedgerError(
      `transaction needs >=2 postings; got ${ps.length} (${JSON.stringify(input.description)})`,
    );
  }
  const byCcy = new Map<string, number>();
  for (const p of ps) {
    byCcy.set(p.currency, (byCcy.get(p.currency) ?? 0) + p.amount);
  }
  for (const [ccy, total] of byCcy) {
    if (Math.abs(total) > TOLERANCE) {
      throw new LedgerError(
        `postings don't balance (${JSON.stringify(input.description)} / ${input.date}): ` +
          `${ccy} sum = ${total.toFixed(4)}`,
      );
    }
  }

  let txnId = 0;
  db.transaction(() => {
    const txn = db
      .query(
        `INSERT INTO transactions_v2 (date, description, notes, derived_by)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.date,
        input.description,
        input.notes ?? null,
        input.derived_by ?? "ingest",
      );
    txnId = Number(txn.lastInsertRowid);

    const insertPosting = db.query(
      `INSERT INTO postings (txn_id, account_id, amount, currency, payee, memo)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const p of ps) {
      insertPosting.run(
        txnId,
        p.account_id,
        p.amount,
        p.currency,
        p.payee ?? null,
        p.memo ?? null,
      );
    }

    const nonEquity = ps
      .filter((p) => !p.account_id.startsWith("equity:"))
      .reduce((s, p) => s + p.amount, 0);
    db.query(
      `INSERT INTO transaction_items (email_id, line_no, name, line_total, category, transaction_v2_id)
       VALUES (NULL, 1, ?, ?, ?, ?)`,
    ).run(input.description ?? "", nonEquity, input.category ?? null, txnId);

    if (input.raw_ids?.length) {
      const linkStmt = db.query(
        "INSERT OR IGNORE INTO event_links (txn_id, raw_id) VALUES (?, ?)",
      );
      for (const rid of input.raw_ids) {
        linkStmt.run(txnId, rid);
      }
    }
  })();

  return txnId;
}
