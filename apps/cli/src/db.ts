import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_DB_PATH    = resolve(HERE, "../../../db/finance.sqlite");
const DEFAULT_CACHE_PATH = resolve(HERE, "../../../db/parser-cache.sqlite");

export function resolveDbPath(): string {
  return process.env.FINANCE_DB ?? DEFAULT_DB_PATH;
}

export function resolveCachePath(): string {
  return process.env.FINANCE_PARSER_CACHE ?? DEFAULT_CACHE_PATH;
}

export function openProductionDb(): Database {
  const db = new Database(resolveDbPath(), { create: false, readwrite: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
