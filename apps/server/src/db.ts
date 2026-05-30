import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations as applyMigrationsImpl } from "@coffer/ledger/schema";

const here = fileURLToPath(new URL(".", import.meta.url));
const DB_PATH = resolve(here, "../../../db/finance.sqlite");
const MIGRATIONS_DIR = resolve(here, "../../../db/migrations");

/** Apply every db/migrations/*.sql file in lex order, tracking applied
 *  versions in schema_migrations. Used by openInMemoryDb() for tests.
 *  Production DBs are migrated via `finance migrate` (Python CLI) until
 *  a `coffer migrate` command exists. */
export function applyMigrations(db: Database): void {
  applyMigrationsImpl(db, MIGRATIONS_DIR);
}

export function openProductionDb(): Database {
  const db = new Database(DB_PATH, { create: false, readwrite: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function openInMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}
