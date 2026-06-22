// apps/server/src/routes/__tests__/provider_tables.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../db";

let db: Database;
beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
afterEach(() => db.close());

test("migration creates provider tables", () => {
  const names = (db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('provider_secrets','provider_connections')")
    .all() as Array<{ name: string }>).map((r) => r.name).sort();
  expect(names).toEqual(["provider_connections", "provider_secrets"]);
});
