import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDb } from "./fixtures/empty";
import { applyMigrations, appliedVersions } from "../src/schema/migrate";

function tmpMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

describe("applyMigrations", () => {
  test("creates schema_migrations table", () => {
    const db = emptyDb();
    const dir = tmpMigrationsDir({});
    try {
      applyMigrations(db, dir);
      const row = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get();
      expect(row).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("applies pending migrations in lex order and records versions", () => {
    const db = emptyDb();
    const dir = tmpMigrationsDir({
      "001_first.sql": "CREATE TABLE foo (id INTEGER);",
      "002_second.sql": "CREATE TABLE bar (id INTEGER);",
    });
    try {
      const applied = applyMigrations(db, dir);
      expect(applied).toEqual(["001_first", "002_second"]);
      expect([...appliedVersions(db)]).toEqual(["001_first", "002_second"]);
      expect(db.query("SELECT * FROM foo").all()).toEqual([]);
      expect(db.query("SELECT * FROM bar").all()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("is idempotent: re-running applies nothing new", () => {
    const db = emptyDb();
    const dir = tmpMigrationsDir({
      "001_first.sql": "CREATE TABLE foo (id INTEGER);",
    });
    try {
      applyMigrations(db, dir);
      const second = applyMigrations(db, dir);
      expect(second).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("ignores non-.sql files", () => {
    const db = emptyDb();
    const dir = tmpMigrationsDir({
      "001_first.sql": "CREATE TABLE foo (id INTEGER);",
      "README.md": "ignore me",
    });
    try {
      const applied = applyMigrations(db, dir);
      expect(applied).toEqual(["001_first"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
