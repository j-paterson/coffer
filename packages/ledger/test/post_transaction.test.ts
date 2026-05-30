import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { emptyDb } from "./fixtures/empty";
import { applyMigrations } from "../src/schema/migrate";
import { postTransaction } from "../src/gatekeepers/post_transaction";
import { recordEvent } from "../src/gatekeepers/record_event";
import { LedgerError } from "../src/gatekeepers/errors";
import { posting } from "../src/gatekeepers/posting";
import { resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dir, "../../../db/migrations");

function seedAccounts(db: Database, ids: string[]): void {
  for (const id of ids) {
    db.query(
      `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, mode, active)
       VALUES (?, ?, 'test', 'checking', 'manual', 1)`,
    ).run(id, id);
  }
}

describe("postTransaction", () => {
  let db: Database;
  beforeEach(() => {
    db = emptyDb();
    applyMigrations(db, MIGRATIONS);
    seedAccounts(db, ["acct:a", "acct:b", "equity:unknown-counterparty"]);
  });

  test("inserts balanced transaction with two postings", () => {
    const txnId = postTransaction(db, {
      date: "2025-01-15",
      description: "Coffee",
      postings: [posting("acct:a", -5.0), posting("acct:b", 5.0)],
    });
    expect(txnId).toBeGreaterThan(0);
    const txn = db.query("SELECT date, description, derived_by FROM transactions_v2 WHERE id = ?")
      .get(txnId) as { date: string; description: string; derived_by: string };
    expect(txn.date).toBe("2025-01-15");
    expect(txn.description).toBe("Coffee");
    expect(txn.derived_by).toBe("ingest");
    const ps = db.query("SELECT account_id, amount FROM postings WHERE txn_id = ? ORDER BY account_id")
      .all(txnId) as Array<{ account_id: string; amount: number }>;
    expect(ps).toEqual([
      { account_id: "acct:a", amount: -5.0 },
      { account_id: "acct:b", amount: 5.0 },
    ]);
  });

  test("rejects unbalanced transactions with LedgerError", () => {
    expect(() =>
      postTransaction(db, {
        date: "2025-01-15",
        description: "Bad",
        postings: [posting("acct:a", -5.0), posting("acct:b", 4.0)],
      }),
    ).toThrow(LedgerError);
  });

  test("requires at least two postings", () => {
    expect(() =>
      postTransaction(db, {
        date: "2025-01-15",
        description: "Solo",
        postings: [posting("acct:a", 0)],
      }),
    ).toThrow(LedgerError);
  });

  test("tolerates rounding within ±$0.005 per currency", () => {
    const txnId = postTransaction(db, {
      date: "2025-01-15",
      description: "Rounding",
      postings: [posting("acct:a", -5.001), posting("acct:b", 5.0)],
    });
    expect(txnId).toBeGreaterThan(0);
  });

  test("balances per currency independently", () => {
    expect(() =>
      postTransaction(db, {
        date: "2025-01-15",
        description: "Mixed",
        postings: [
          posting("acct:a", -5.0, { currency: "USD" }),
          posting("acct:b", 5.0, { currency: "EUR" }),
        ],
      }),
    ).toThrow(LedgerError);
  });

  test("links raw_ids via event_links", () => {
    const rawId = recordEvent(db, {
      source: "simplefin",
      external_id: "txn-1",
      payload: {},
    });
    expect(rawId).toBeGreaterThan(0);
    const txnId = postTransaction(db, {
      date: "2025-01-15",
      description: "Linked",
      postings: [posting("acct:a", -5.0), posting("acct:b", 5.0)],
      raw_ids: [rawId!],
    });
    const links = db.query("SELECT raw_id FROM event_links WHERE txn_id = ?")
      .all(txnId) as Array<{ raw_id: number }>;
    expect(links).toEqual([{ raw_id: rawId! }]);
  });

  test("synthesizes a transaction_items row when category is provided", () => {
    const txnId = postTransaction(db, {
      date: "2025-01-15",
      description: "Coffee at Stumptown",
      postings: [
        posting("acct:a", -5.0, { payee: "Stumptown" }),
        posting("equity:unknown-counterparty", 5.0),
      ],
      category: "food:coffee",
    });
    const items = db.query(
      "SELECT name, line_total, category FROM transaction_items WHERE transaction_v2_id = ?",
    ).all(txnId) as Array<{ name: string; line_total: number; category: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      name: "Coffee at Stumptown",
      line_total: -5.0,
      category: "food:coffee",
    });
  });

  test("derived_by override is recorded", () => {
    const txnId = postTransaction(db, {
      date: "2025-01-15",
      description: "Imported",
      postings: [posting("acct:a", -5.0), posting("acct:b", 5.0)],
      derived_by: "kubera-recap",
    });
    const row = db.query("SELECT derived_by FROM transactions_v2 WHERE id = ?")
      .get(txnId) as { derived_by: string };
    expect(row.derived_by).toBe("kubera-recap");
  });
});
