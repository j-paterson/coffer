import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { applyMigrations } from "@coffer/ledger/schema";
import { runOperations } from "@coffer/ledger/runner";
import { manualCsvParser } from "../src/manual-csv";
import { ManualCsvConfig } from "../src/manual-csv/config";
import { ConsoleLogger } from "../src/types/logger";
import { buildContext } from "../src/context";

const FIXTURE = resolve(import.meta.dir, "fixtures/bank-export.csv");
const MIGRATIONS = resolve(import.meta.dir, "../../../db/migrations");

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };

const ACCOUNT_ID = "manual:northwind-checking";

function makeCtx() {
  const config = ManualCsvConfig.parse({
    account_id: ACCOUNT_ID,
    files: [FIXTURE],
    columns: { date: "Posting Date", description: "Memo", amount: "Amount" },
    account: {
      display_name: "Northwind Checking",
      institution: "Northwind Bank",
      type: "checking",
    },
  });
  return buildContext({
    config,
    logger: new ConsoleLogger(SILENT_SINK),
    now: () => new Date("2025-02-01T00:00:00Z"),
  });
}

describe("manualCsvParser end-to-end through runOperations", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, MIGRATIONS);
    // Seed the equity counterparty the one_sided gatekeeper needs.
    db.query(
      `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, mode, active)
       VALUES ('equity:unknown-counterparty', 'Unknown', 'system', 'equity', 'manual', 1)`,
    ).run();
  });

  test("first sync populates raw_events, transactions, accounts, sync_warnings", async () => {
    const ctx = makeCtx();
    const summary = await runOperations(db, manualCsvParser.sync(ctx));

    expect(summary).toMatchObject({
      raw_events: 4,
      transactions: 4,
      accounts_discovered: 1,
      warnings: 2,
    });

    const acct = db.query(
      "SELECT id, display_name, institution, mode FROM accounts WHERE id = ?",
    ).get(ACCOUNT_ID) as { id: string; display_name: string; institution: string; mode: string };
    expect(acct).toEqual({
      id: ACCOUNT_ID,
      display_name: "Northwind Checking",
      institution: "Northwind Bank",
      mode: "manual",
    });

    const rawCount = (db.query("SELECT COUNT(*) AS n FROM raw_events WHERE source = 'manual-csv'")
      .get() as { n: number }).n;
    expect(rawCount).toBe(4);

    const txnCount = (db.query("SELECT COUNT(*) AS n FROM transactions_v2").get() as { n: number }).n;
    expect(txnCount).toBe(4);

    const warnings = db.query(
      "SELECT message FROM sync_warnings WHERE source = 'manual-csv' ORDER BY id",
    ).all() as Array<{ message: string }>;
    expect(warnings.length).toBe(2);
    expect(warnings[0]?.message).toMatch(/amount/i);
    expect(warnings[1]?.message).toMatch(/YYYY-MM-DD/);

    // Postings: 4 manual:northwind-checking + 4 equity:unknown-counterparty.
    const postings = db.query(
      "SELECT account_id, COUNT(*) AS n FROM postings GROUP BY account_id ORDER BY account_id",
    ).all() as Array<{ account_id: string; n: number }>;
    expect(postings).toEqual([
      { account_id: "equity:unknown-counterparty", n: 4 },
      { account_id: ACCOUNT_ID, n: 4 },
    ]);
  });

  test("second sync is a no-op (idempotency contract)", async () => {
    const ctx = makeCtx();
    await runOperations(db, manualCsvParser.sync(ctx));

    const txnsBefore = (db.query("SELECT COUNT(*) AS n FROM transactions_v2").get() as { n: number }).n;
    const rawsBefore = (db.query("SELECT COUNT(*) AS n FROM raw_events").get() as { n: number }).n;

    const summary2 = await runOperations(db, manualCsvParser.sync(ctx));
    expect(summary2.raw_events).toBe(0);
    expect(summary2.transactions).toBe(0);

    const txnsAfter = (db.query("SELECT COUNT(*) AS n FROM transactions_v2").get() as { n: number }).n;
    const rawsAfter = (db.query("SELECT COUNT(*) AS n FROM raw_events").get() as { n: number }).n;
    expect(txnsAfter).toBe(txnsBefore);
    expect(rawsAfter).toBe(rawsBefore);
  });

  test("two duplicate-content rows produce distinct raw_events via line_number", async () => {
    const ctx = makeCtx();
    await runOperations(db, manualCsvParser.sync(ctx));

    const dupes = db.query(
      `SELECT external_id FROM raw_events
       WHERE source = 'manual-csv'
         AND json_extract(payload, '$.description') = 'Coffee shop'
         AND json_extract(payload, '$.amount') = -4.75`,
    ).all() as Array<{ external_id: string }>;
    expect(dupes.length).toBe(2);
    expect(dupes[0]?.external_id).not.toBe(dupes[1]?.external_id);
  });
});
