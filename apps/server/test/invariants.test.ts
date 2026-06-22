import { describe, expect, test } from "bun:test";
import { createTestCtx } from "./setup";
import {
  InvariantError,
  INV_1_postingsBalance,
  INV_2_postingAccountExists,
  INV_5_noMergeCycles,
  INV_7_equityAccountType,
  runAll,
} from "./invariants";

describe("invariants", () => {
  test("INV-1 passes on balanced txn", () => {
    const { db } = createTestCtx();
    db.exec("INSERT INTO accounts (id, display_name, institution, type, currency, active, mode) VALUES ('a', 'A', 'I', 'checking', 'USD', 1, 'live')");
    db.exec("INSERT INTO accounts (id, display_name, institution, type, currency, active, mode) VALUES ('b', 'B', 'I', 'checking', 'USD', 1, 'live')");
    db.exec("INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2025-01-01', 'x', 'ingest')");
    const txnId = (db.query("SELECT last_insert_rowid() id").get() as { id: number }).id;
    db.run("INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'a', 100.00)", [txnId]);
    db.run("INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'b', -100.00)", [txnId]);
    INV_1_postingsBalance(db);
  });

  test("INV-1 raises on unbalanced txn", () => {
    const { db } = createTestCtx();
    db.exec("INSERT INTO accounts (id, display_name, institution, type, currency, active, mode) VALUES ('a', 'A', 'I', 'checking', 'USD', 1, 'live')");
    db.exec("INSERT INTO accounts (id, display_name, institution, type, currency, active, mode) VALUES ('b', 'B', 'I', 'checking', 'USD', 1, 'live')");
    db.exec("INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2025-01-01', 'x', 'ingest')");
    const txnId = (db.query("SELECT last_insert_rowid() id").get() as { id: number }).id;
    db.run("INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'a', 100.00)", [txnId]);
    db.run("INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'b', -50.00)", [txnId]);
    expect(() => INV_1_postingsBalance(db)).toThrow(/INV-1/);
  });

  test("INV-5 detects merge cycle", () => {
    const { db } = createTestCtx();
    db.exec("INSERT INTO accounts (id, display_name, institution, type, currency, active, mode) VALUES ('a', 'A', 'I', 'checking', 'USD', 1, 'live')");
    db.exec("INSERT INTO accounts (id, display_name, institution, type, currency, active, mode) VALUES ('b', 'B', 'I', 'checking', 'USD', 1, 'live')");
    db.exec("UPDATE accounts SET merged_into='b' WHERE id='a'");
    db.exec("UPDATE accounts SET merged_into='a' WHERE id='b'");
    expect(() => INV_5_noMergeCycles(db)).toThrow(/INV-5/);
  });

  test("runAll passes on empty DB", () => {
    const { db } = createTestCtx();
    runAll(db);
  });
});
