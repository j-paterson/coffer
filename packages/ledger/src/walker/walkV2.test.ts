/** Tests for walkSeveralCanonicals.
 *
 *  We use an in-memory SQLite database seeded with the minimal schema the
 *  walker touches, avoiding the full migration stack so the tests run fast
 *  and stay isolated. */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { walkSeveralCanonicals } from "./walkV2";
import type { LedgerCtx } from "./ctx";
import { DEFAULT_ASSET_ONLY_TYPES } from "./balanceWalk";

// ---------------------------------------------------------------------------
// Minimal schema helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    -- data_sources must have at least one row so sourceRankCase() in cohort.ts
    -- generates a valid CASE…WHEN…ELSE expression (CASE source ELSE … END without
    -- any WHEN is invalid SQLite syntax).
    CREATE TABLE data_sources (
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      trust_rank INTEGER NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (name, kind)
    );
    INSERT INTO data_sources (name, kind, trust_rank, enabled) VALUES
      ('manual',    'assertion', 0, 1),
      ('simplefin', 'assertion', 1, 1),
      ('simplefin', 'snapshot',  0, 1);
  `);

  db.exec(`
    CREATE TABLE accounts (
      id           TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      institution  TEXT NOT NULL DEFAULT 'test',
      type         TEXT NOT NULL DEFAULT 'checking',
      currency     TEXT NOT NULL DEFAULT 'USD',
      active       INTEGER NOT NULL DEFAULT 1,
      mode         TEXT NOT NULL DEFAULT 'manual',
      merged_into  TEXT REFERENCES accounts(id)
    );

    CREATE TABLE transactions_v2 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      description TEXT,
      derived_by TEXT NOT NULL DEFAULT 'ingest',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE postings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      txn_id     INTEGER NOT NULL REFERENCES transactions_v2(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      amount     REAL NOT NULL,
      currency   TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE balance_assertions (
      account_id   TEXT NOT NULL REFERENCES accounts(id),
      as_of        TEXT NOT NULL,
      expected_usd REAL NOT NULL,
      source       TEXT NOT NULL,
      PRIMARY KEY (account_id, as_of, source)
    );

    CREATE TABLE positions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      chain            TEXT NOT NULL DEFAULT '',
      contract_address TEXT NOT NULL DEFAULT '',
      symbol           TEXT NOT NULL,
      asset_class      TEXT,
      UNIQUE(account_id, chain, contract_address, symbol)
    );

    CREATE TABLE position_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      as_of       TEXT NOT NULL,
      source      TEXT NOT NULL,
      quantity    REAL,
      value_usd   REAL NOT NULL,
      cost_basis  REAL,
      ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(position_id, as_of, source)
    );
  `);

  return db;
}

/** Seed a simple checking account with postings on two dates.
 *  Returns the canonical account id. */
function seedCheckingAccount(db: Database, id = "acct:checking"): string {
  db.exec(`
    INSERT INTO accounts (id, display_name, type, active)
    VALUES ('${id}', 'Test Checking', 'checking', 1);
  `);

  // Posting on 2019-06-01 — before the "classic" personal floor
  db.exec(`
    INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2019-06-01', 'Old deposit', 'ingest');
  `);
  const txn1Id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.exec(`
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn1Id}, '${id}', 1000);
  `);
  // Equity counterpart (not strictly needed for a summing query, but realistic)
  db.exec(`
    INSERT INTO accounts (id, display_name, type, active) VALUES ('equity:opening-balance', 'Opening Balance', 'alt', 1)
    ON CONFLICT DO NOTHING;
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn1Id}, 'equity:opening-balance', -1000);
  `);

  // Posting on 2021-03-15 — after any reasonable floor
  db.exec(`
    INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2021-03-15', 'Later deposit', 'ingest');
  `);
  const txn2Id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.exec(`
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn2Id}, '${id}', 500);
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn2Id}, 'equity:opening-balance', -500);
  `);

  return id;
}

/** Build a minimal LedgerCtx. `today` is pinned so the walk has a known
 *  end-date and tests don't depend on the real clock. */
function makeCtx(db: Database, overrides?: Partial<LedgerCtx>): LedgerCtx {
  return {
    db,
    today: "2021-04-01",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("walkSeveralCanonicals — date range", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("all dates from first signal are included", () => {
    const id = seedCheckingAccount(db);
    const ctx = makeCtx(db);

    const result = walkSeveralCanonicals(ctx, [id]);
    const series = result.get(id)!;

    expect(series).toBeDefined();
    // The walk should start from the earliest posting date (2019-06-01)
    expect(series.has("2019-06-01")).toBe(true);
    // and continue through today
    expect(series.has("2021-03-15")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assetOnlyTypes tests
// ---------------------------------------------------------------------------

/** Seed a savings account whose postings yield a net negative balance.
 *  Returns the canonical account id. */
function seedNegativeSavingsAccount(db: Database, id = "acct:savings"): string {
  db.exec(`
    INSERT INTO accounts (id, display_name, type, active)
    VALUES ('${id}', 'Test Savings', 'savings', 1);
    INSERT INTO accounts (id, display_name, type, active)
      VALUES ('equity:opening-balance', 'Opening Balance', 'alt', 1)
      ON CONFLICT DO NOTHING;
  `);

  // Deposit 100, then withdraw 500 → net −400
  db.exec(`INSERT INTO transactions_v2 (date, derived_by) VALUES ('2021-01-01', 'ingest');`);
  const txn1Id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.exec(`
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn1Id}, '${id}', 100);
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn1Id}, 'equity:opening-balance', -100);
  `);

  db.exec(`INSERT INTO transactions_v2 (date, derived_by) VALUES ('2021-01-15', 'ingest');`);
  const txn2Id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.exec(`
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn2Id}, '${id}', -500);
    INSERT INTO postings (txn_id, account_id, amount) VALUES (${txn2Id}, 'equity:opening-balance', 500);
  `);

  return id;
}

describe("walkSeveralCanonicals — assetOnlyTypes", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("savings account with negative balance is clamped to 0", () => {
    const id = seedNegativeSavingsAccount(db);
    // "savings" is in DEFAULT_ASSET_ONLY_TYPES, so negatives clamp to 0
    expect(DEFAULT_ASSET_ONLY_TYPES.has("savings")).toBe(true);

    const ctx = makeCtx(db, { today: "2021-01-15" });
    const result = walkSeveralCanonicals(ctx, [id]);
    const series = result.get(id)!;

    expect(series).toBeDefined();
    // Net balance on 2021-01-15 is −400 → clamped to 0
    expect(series.get("2021-01-15")).toBe(0);
    // Balance on 2021-01-01 is +100 → positive, untouched
    expect(series.get("2021-01-01")).toBe(100);
  });
});
