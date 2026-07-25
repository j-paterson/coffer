import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootEnv } from "@coffer/config/env";
import { applyMigrations as applyMigrationsImpl } from "@coffer/ledger/schema";

// Load the repo-root .env before reading FINANCE_DB. `bun run --filter` launches
// this workspace with the package dir as cwd, so Bun's cwd-based .env auto-load
// misses the root file where a live instance points FINANCE_DB at its real DB.
// Without this the server silently falls back to the in-tree default below.
loadRootEnv();

const here = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_DB_PATH = resolve(here, "../../../db/finance.sqlite");
const MIGRATIONS_DIR = resolve(here, "../../../db/migrations");

// Resolved lazily (not at module load) so it reflects FINANCE_DB after env is
// loaded, and so tests that mutate the env observe the change.
function resolveDbPath(): string {
  return process.env.FINANCE_DB
    ? resolve(process.cwd(), process.env.FINANCE_DB)
    : DEFAULT_DB_PATH;
}

export function applyMigrations(db: Database): void {
  applyMigrationsImpl(db, MIGRATIONS_DIR);
}

export function openProductionDb(): Database {
  const dbPath = resolveDbPath();
  // Log the resolved path and whether we're about to create a brand-new file.
  // First-run auto-create is intended, but a *silent* empty DB (e.g. a live
  // instance whose FINANCE_DB never loaded) is the footgun this makes loud.
  const source = process.env.FINANCE_DB ? "FINANCE_DB" : "default";
  const creating = !existsSync(dbPath);
  console.log(
    `[api] database: ${dbPath} (${source}${creating ? ", creating new empty DB" : ""})`,
  );

  const db = new Database(dbPath, { create: true, readwrite: true });
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
