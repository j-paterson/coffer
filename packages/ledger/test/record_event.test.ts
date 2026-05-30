import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { emptyDb } from "./fixtures/empty";
import { applyMigrations } from "../src/schema/migrate";
import { recordEvent } from "../src/gatekeepers/record_event";
import { resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dir, "../../../db/migrations");

describe("recordEvent", () => {
  let db: Database;
  beforeEach(() => {
    db = emptyDb();
    applyMigrations(db, MIGRATIONS);
  });

  test("inserts a new raw event and returns its id", () => {
    const id = recordEvent(db, {
      source: "simplefin",
      external_id: "txn-123",
      payload: { amount: 5.0, posted: "2025-01-01" },
    });
    expect(id).toBeGreaterThan(0);
    const row = db
      .query("SELECT source, external_id, payload FROM raw_events WHERE id = ?")
      .get(id) as { source: string; external_id: string; payload: string };
    expect(row.source).toBe("simplefin");
    expect(row.external_id).toBe("txn-123");
    expect(JSON.parse(row.payload)).toEqual({ amount: 5.0, posted: "2025-01-01" });
  });

  test("returns null on (source, external_id) collision (idempotency)", () => {
    const a = recordEvent(db, { source: "s", external_id: "x", payload: { v: 1 } });
    const b = recordEvent(db, { source: "s", external_id: "x", payload: { v: 2 } });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeNull();
    const row = db.query("SELECT payload FROM raw_events WHERE id = ?").get(a) as { payload: string };
    expect(JSON.parse(row.payload)).toEqual({ v: 1 });
  });

  test("records source_file when provided", () => {
    const id = recordEvent(db, {
      source: "chase-statement",
      external_id: "stmt-2024-12",
      payload: {},
      source_file: "raw/chase/20241201-statements-1234.pdf",
    });
    const row = db.query("SELECT source_file FROM raw_events WHERE id = ?").get(id) as {
      source_file: string;
    };
    expect(row.source_file).toBe("raw/chase/20241201-statements-1234.pdf");
  });
});
