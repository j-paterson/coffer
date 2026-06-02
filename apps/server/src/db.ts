import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations as applyMigrationsImpl } from "@coffer/ledger/schema";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_DB_PATH = resolve(here, "../../../db/finance.sqlite");
const DB_PATH = process.env.FINANCE_DB
  ? resolve(process.cwd(), process.env.FINANCE_DB)
  : DEFAULT_DB_PATH;
const MIGRATIONS_DIR = resolve(here, "../../../db/migrations");

export function applyMigrations(db: Database): void {
  applyMigrationsImpl(db, MIGRATIONS_DIR);
}

export function openProductionDb(): Database {
  const db = new Database(DB_PATH, { create: true, readwrite: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}

export function openInMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}
