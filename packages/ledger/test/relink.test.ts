import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { emptyDb } from "./fixtures/empty";
import { applyMigrations } from "../src/schema/migrate";
import { postTransaction } from "../src/gatekeepers/post_transaction";
import { oneSided } from "../src/gatekeepers/one_sided";
import { posting } from "../src/gatekeepers/posting";
import { applyRelinkPlan, latestFeed, planRelink } from "../src/relink";

const MIGRATIONS = resolve(import.meta.dir, "../../../db/migrations");
const P = "simplefin:";

let db: Database;

function account(id: string, name: string, firstAsOf: string, seenAt: string | null, institution = "Northwind Bank") {
  db.query(
    `INSERT INTO accounts (id, display_name, institution, type, mode, active, last_seen_at)
     VALUES (?, ?, ?, 'credit', 'live', 1, ?)`,
  ).run(P + id, name, institution, seenAt);
  db.query(
    `INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES (?, ?, 0, 'simplefin')`,
  ).run(P + id, firstAsOf);
}

const txn = (id: string, date: string, amount: number, description: string) =>
  postTransaction(db, { date, description, postings: [...oneSided(P + id, amount)] });

const count = (sql: string, ...args: (string | number)[]) =>
  (db.query(sql).get(...args) as { n: number }).n;

beforeEach(() => {
  db = emptyDb();
  applyMigrations(db, MIGRATIONS);
});

describe("planRelink / applyRelinkPlan", () => {
  beforeEach(() => {
    // Old card: history since January, dropped out of the feed (stale stamp).
    account("old-card", "Rewards Card (1234)", "2026-01-01", "2026-09-01T00:00:00Z");
    // Reconnected: same card, new id, in the latest feed.
    account("new-card", "Rewards Card (1234)", "2026-10-05", "2026-10-05T00:00:00Z");
    // Untouched account in the feed.
    account("checking", "Checking (9999)", "2026-01-01", "2026-10-05T00:00:00Z");
  });

  test("pairs the orphan with its same-name replacement", () => {
    const plan = planRelink(db, { prefix: P, seen: latestFeed(db, P) });
    expect(plan.pairs.map((p) => [p.canonical, p.alias])).toEqual([[P + "old-card", P + "new-card"]]);
    expect(plan.ambiguous).toEqual([]);
  });

  test("matches duplicates on amount within a date window, ignoring masked digits", () => {
    const keepA = txn("old-card", "2026-09-10", -60.99, "AIRLINE 0062445514145");
    const keepB = txn("old-card", "2026-09-12", -15, "PARKING");
    txn("old-card", "2026-08-01", -15, "PARKING"); // before the overlap window
    txn("old-card", "2026-09-20", -5, "COFFEE"); // old card's last transaction
    const dupA = txn("new-card", "2026-09-10", -60.99, "AIRLINE XXXXXXXXX4145");
    const dupB = txn("new-card", "2026-09-13", -15, "PARKING"); // posted a day later
    txn("new-card", "2026-10-03", -42, "NEW PURCHASE"); // after the disconnect — keep

    const plan = planRelink(db, { prefix: P, seen: latestFeed(db, P) });
    const pair = plan.pairs[0]!;
    expect(pair.duplicates.map((d) => [d.txn_id, d.keeper_txn_id])).toEqual([
      [dupA, keepA],
      [dupB, keepB],
    ]);
    expect(pair.needs_review).toEqual([]);

    applyRelinkPlan(db, plan, "2026-10-05");
    expect(count("SELECT COUNT(*) n FROM transactions_v2 WHERE id IN (?, ?)", dupA, dupB)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM postings WHERE account_id = ?", P + "new-card")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM postings WHERE account_id = ?", P + "old-card")).toBe(4);
    expect(
      (db.query("SELECT merged_into FROM accounts WHERE id = ?").get(P + "new-card") as { merged_into: string })
        .merged_into,
    ).toBe(P + "old-card");
    const note = db.query("SELECT kind, detail FROM reconciliation_notes WHERE account_id = ?").get(P + "old-card") as {
      kind: string;
      detail: string;
    };
    expect(note.kind).toBe("relink");
    expect(JSON.parse(note.detail).removed).toHaveLength(2);
  });

  test("moves receipts and user metadata onto the surviving transaction", () => {
    const keep = txn("old-card", "2026-09-10", -20, "CAFE");
    const dup = txn("new-card", "2026-09-10", -20, "CAFE");
    db.query("UPDATE transactions_v2 SET notes = 'team lunch' WHERE id = ?").run(dup);
    db.query("INSERT INTO emails (id, received_at, from_addr, subject, raw_path, transaction_v2_id) VALUES ('m1', '2026-09-10', 'a@example.com', 'Receipt', 'x.eml', ?)").run(dup);

    applyRelinkPlan(db, planRelink(db, { prefix: P, seen: latestFeed(db, P) }), "2026-10-05");
    expect((db.query("SELECT notes FROM transactions_v2 WHERE id = ?").get(keep) as { notes: string }).notes).toBe(
      "team lunch",
    );
    expect(count("SELECT COUNT(*) n FROM emails WHERE transaction_v2_id = ?", keep)).toBe(1);
  });

  test("never deletes a duplicate that also moves money on an unrelated account", () => {
    txn("old-card", "2026-09-20", 500, "PAYMENT THANK YOU");
    const transfer = postTransaction(db, {
      date: "2026-09-20",
      description: "CARD PAYMENT",
      postings: [posting(P + "new-card", 500), posting(P + "checking", -500)],
    });
    const plan = planRelink(db, { prefix: P, seen: latestFeed(db, P) });
    expect(plan.pairs[0]!.duplicates).toEqual([]);
    expect(plan.pairs[0]!.needs_review.map((d) => d.txn_id)).toEqual([transfer]);
    applyRelinkPlan(db, plan, "2026-10-05");
    expect(count("SELECT COUNT(*) n FROM postings WHERE txn_id = ?", transfer)).toBe(2);
  });

  test("a same-amount charge newer than anything on the old card is never a duplicate", () => {
    txn("old-card", "2026-09-10", -15, "PARKING"); // last day the old card synced
    txn("new-card", "2026-09-11", -15, "PARKING"); // new charge the next day
    const [pair] = planRelink(db, { prefix: P, seen: latestFeed(db, P) }).pairs;
    expect(pair!.duplicates).toEqual([]);
    expect(pair!.needs_review).toEqual([]);
  });

  test("same amount and date but different text goes to review, not deletion", () => {
    txn("old-card", "2026-09-10", -30, "GROCER");
    const other = txn("new-card", "2026-09-10", -30, "HARDWARE STORE");
    const [pair] = planRelink(db, { prefix: P, seen: latestFeed(db, P) }).pairs;
    expect(pair!.duplicates).toEqual([]);
    expect(pair!.needs_review.map((d) => d.txn_id)).toEqual([other]);
  });

  test("an exact match is not stolen by an earlier near miss", () => {
    const keepA = txn("old-card", "2026-09-10", -15, "PARKING");
    const keepB = txn("old-card", "2026-09-12", -15, "PARKING");
    const dupA = txn("new-card", "2026-09-11", -15, "PARKING"); // 1 day from both
    const dupB = txn("new-card", "2026-09-12", -15, "PARKING");
    const [pair] = planRelink(db, { prefix: P, seen: latestFeed(db, P) }).pairs;
    expect(pair!.duplicates.map((d) => [d.txn_id, d.keeper_txn_id])).toEqual([
      [dupA, keepA],
      [dupB, keepB],
    ]);
  });

  test("line items move to the keeper instead of being deleted", () => {
    const keep = txn("old-card", "2026-09-10", -20, "CAFE");
    const dup = txn("new-card", "2026-09-10", -20, "CAFE");
    // The user categorized the duplicate's synthesized item, and a receipt
    // email's item was attached to it.
    db.query("UPDATE transaction_items SET category = 'Dining', category_source = 'user' WHERE transaction_v2_id = ?").run(dup);
    db.query("INSERT INTO emails (id, received_at, from_addr, subject, raw_path) VALUES ('m2', '2026-09-10', 'a@example.com', 'Receipt', 'y.eml')").run();
    db.query("INSERT INTO transaction_items (email_id, line_no, name, transaction_v2_id) VALUES ('m2', 1, 'Latte', ?)").run(dup);
    db.query("UPDATE transactions_v2 SET excluded_from_spending = 1 WHERE id = ?").run(dup);
    applyRelinkPlan(db, planRelink(db, { prefix: P, seen: latestFeed(db, P) }), "2026-10-05");
    expect(count("SELECT COUNT(*) n FROM transaction_items WHERE transaction_v2_id = ? AND category = 'Dining'", keep)).toBe(1);
    expect(count("SELECT COUNT(*) n FROM transaction_items WHERE transaction_v2_id = ? AND email_id = 'm2'", keep)).toBe(1);
    expect(count("SELECT COUNT(*) n FROM transaction_items WHERE transaction_v2_id = ?", keep)).toBe(2);
    expect(count("SELECT excluded_from_spending n FROM transactions_v2 WHERE id = ?", keep)).toBe(1);
  });

  test("a user category reaches a receipt-itemized keeper that has no placeholder", () => {
    const keep = txn("old-card", "2026-09-10", -20, "CAFE");
    const dup = txn("new-card", "2026-09-10", -20, "CAFE");
    // Keeper itemized by a receipt: its placeholder was replaced by the lines.
    db.query("INSERT INTO emails (id, received_at, from_addr, subject, raw_path) VALUES ('m3', '2026-09-10', 'a@example.com', 'Receipt', 'z.eml')").run();
    db.query("DELETE FROM transaction_items WHERE transaction_v2_id = ?").run(keep);
    db.query("INSERT INTO transaction_items (email_id, line_no, name, line_total, category, category_source, transaction_v2_id) VALUES ('m3', 1, 'Latte', -20, 'Groceries', 'learned', ?)").run(keep);
    db.query("UPDATE transaction_items SET category = 'Dining', category_source = 'user' WHERE transaction_v2_id = ?").run(dup);
    applyRelinkPlan(db, planRelink(db, { prefix: P, seen: latestFeed(db, P) }), "2026-10-05");
    expect(count("SELECT COUNT(*) n FROM transaction_items WHERE transaction_v2_id = ? AND category = 'Dining' AND email_id = 'm3'", keep)).toBe(1);
  });

  test("only the reviewed aliases are planned", () => {
    expect(planRelink(db, { prefix: P, seen: latestFeed(db, P), only: new Set(["x"]) }).pairs).toEqual([]);
  });

  test("planning writes nothing", () => {
    txn("old-card", "2026-09-10", -20, "CAFE");
    txn("new-card", "2026-09-10", -20, "CAFE");
    planRelink(db, { prefix: P, seen: latestFeed(db, P) });
    expect(count("SELECT COUNT(*) n FROM transactions_v2")).toBe(2);
    expect(count("SELECT COUNT(*) n FROM accounts WHERE merged_into IS NOT NULL")).toBe(0);
  });
});

describe("safety rules", () => {
  test("leaves name collisions with several candidates alone", () => {
    account("a1", "Checking (1111)", "2026-01-01", null);
    account("a2", "Checking (1111)", "2026-01-01", null);
    account("a3", "Checking (1111)", "2026-10-05", "2026-10-05T00:00:00Z");
    const plan = planRelink(db, { prefix: P, seen: latestFeed(db, P) });
    expect(plan.pairs).toEqual([]);
    expect(plan.ambiguous).toEqual(["Northwind Bank · Checking (1111)"]);
  });

  test("two same-name accounts that both kept syncing are never paired", () => {
    // One account simply missing from a partial sync: its balance history
    // overlaps the other's, so it isn't a reconnect.
    account("sav-a", "Savings", "2025-01-01", "2026-09-01T00:00:00Z");
    account("sav-b", "Savings", "2025-06-01", "2026-10-05T00:00:00Z");
    db.query("INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES (?, '2026-10-04', 0, 'simplefin')").run(P + "sav-a");
    const plan = planRelink(db, { prefix: P, seen: latestFeed(db, P) });
    expect(plan.pairs).toEqual([]);
    expect(plan.ambiguous).toEqual(["Northwind Bank · Savings"]);
  });

  test("does not pair across institutions", () => {
    account("old", "Checking (1111)", "2026-01-01", null, "Northwind Bank");
    account("new", "Checking (1111)", "2026-10-05", "2026-10-05T00:00:00Z", "Summit Brokerage");
    expect(planRelink(db, { prefix: P, seen: latestFeed(db, P) }).pairs).toEqual([]);
  });

  test("an account missing from the feed with no replacement is left alone", () => {
    account("closed", "Old Card (2222)", "2026-01-01", "2026-09-01T00:00:00Z");
    account("checking", "Checking (9999)", "2026-01-01", "2026-10-05T00:00:00Z");
    expect(planRelink(db, { prefix: P, seen: latestFeed(db, P) })).toEqual({ pairs: [], ambiguous: [] });
  });

  test("nothing is relinked before any sync has stamped the feed", () => {
    account("old", "Card (3333)", "2026-01-01", null);
    account("new", "Card (3333)", "2026-10-05", null);
    expect(latestFeed(db, P).size).toBe(0);
    expect(planRelink(db, { prefix: P, seen: latestFeed(db, P) }).pairs).toEqual([]);
  });
});
