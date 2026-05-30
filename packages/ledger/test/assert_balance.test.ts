import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { emptyDb } from "./fixtures/empty";
import { applyMigrations } from "../src/schema/migrate";
import { assertBalance } from "../src/gatekeepers/assert_balance";
import { resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dir, "../../../db/migrations");

function seedAccount(db: Database, id: string): void {
  db.query(
    `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, mode, active)
     VALUES (?, ?, 'test', 'checking', 'manual', 1)`,
  ).run(id, id);
}

describe("assertBalance", () => {
  let db: Database;
  beforeEach(() => {
    db = emptyDb();
    applyMigrations(db, MIGRATIONS);
    seedAccount(db, "acct:checking");
  });

  test("inserts a new balance assertion", () => {
    assertBalance(db, {
      account_id: "acct:checking",
      as_of: "2025-01-15",
      expected_usd: 1234.56,
      source: "chase-statement",
    });
    const row = db
      .query("SELECT expected_usd, source_file FROM balance_assertions WHERE account_id = ? AND as_of = ? AND source = ?")
      .get("acct:checking", "2025-01-15", "chase-statement") as
      | { expected_usd: number; source_file: string | null }
      | null;
    expect(row).toEqual({ expected_usd: 1234.56, source_file: null });
  });

  test("upserts on (account_id, as_of, source) collision", () => {
    assertBalance(db, {
      account_id: "acct:checking",
      as_of: "2025-01-15",
      expected_usd: 100,
      source: "chase-statement",
      source_file: "raw/chase/old.pdf",
    });
    assertBalance(db, {
      account_id: "acct:checking",
      as_of: "2025-01-15",
      expected_usd: 200,
      source: "chase-statement",
      source_file: "raw/chase/new.pdf",
    });
    const rows = db
      .query("SELECT expected_usd, source_file FROM balance_assertions WHERE account_id = ? AND as_of = ?")
      .all("acct:checking", "2025-01-15") as Array<{ expected_usd: number; source_file: string }>;
    expect(rows).toEqual([{ expected_usd: 200, source_file: "raw/chase/new.pdf" }]);
  });

  test("different sources for same (account, date) coexist", () => {
    assertBalance(db, {
      account_id: "acct:checking", as_of: "2025-01-15", expected_usd: 100,
      source: "chase-statement",
    });
    assertBalance(db, {
      account_id: "acct:checking", as_of: "2025-01-15", expected_usd: 105,
      source: "simplefin",
    });
    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM balance_assertions WHERE account_id = ?")
      .get("acct:checking") as { n: number } | null;
    expect(count?.n).toBe(2);
  });
});
