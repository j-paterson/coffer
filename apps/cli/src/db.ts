import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { applyMigrations } from "@coffer/ledger/schema";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_DB_PATH    = resolve(HERE, "../../../db/finance.sqlite");
const DEFAULT_CACHE_PATH = resolve(HERE, "../../../db/parser-cache.sqlite");
const MIGRATIONS_DIR     = resolve(HERE, "../../../db/migrations");

export function resolveDbPath(): string {
  return process.env.FINANCE_DB ?? DEFAULT_DB_PATH;
}

export function resolveCachePath(): string {
  return process.env.FINANCE_PARSER_CACHE ?? DEFAULT_CACHE_PATH;
}

export function openProductionDb(): Database {
  const db = new Database(resolveDbPath(), { create: true, readwrite: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}
