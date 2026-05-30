import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { emptyDb } from "./fixtures/empty";
import { applyMigrations } from "../src/schema/migrate";
import { noteReconciliation } from "../src/gatekeepers/note_reconciliation";
import { resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dir, "../../../db/migrations");

describe("noteReconciliation", () => {
  let db: Database;
  beforeEach(() => {
    db = emptyDb();
    applyMigrations(db, MIGRATIONS);
    db.query(
      `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, mode, active) VALUES (?, ?, 'test', 'checking', 'manual', 1)`,
    ).run("acct:a", "acct:a");
  });

  test("inserts an append-only note with serialized detail", () => {
    noteReconciliation(db, {
      account_id: "acct:a",
      as_of: "2025-01-15",
      kind: "assertion_delta",
      detail: { delta: 1.23, source: "simplefin" },
    });
    const row = db
      .query("SELECT account_id, as_of, kind, detail FROM reconciliation_notes WHERE account_id = ?")
      .get("acct:a") as { account_id: string; as_of: string; kind: string; detail: string };
    expect(row.account_id).toBe("acct:a");
    expect(row.as_of).toBe("2025-01-15");
    expect(row.kind).toBe("assertion_delta");
    expect(JSON.parse(row.detail)).toEqual({ delta: 1.23, source: "simplefin" });
  });
});
