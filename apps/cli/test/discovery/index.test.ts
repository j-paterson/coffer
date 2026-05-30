import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "@coffer/ledger/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDiscovery } from "../../src/discovery/index";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../../../db/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe("runDiscovery", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("returns {} for parsers without a shim", () => {
    expect(runDiscovery("simplefin",  db)).toEqual({});
    expect(runDiscovery("coinbase",   db)).toEqual({});
    expect(runDiscovery("alchemy",    db)).toEqual({});
    expect(runDiscovery("zerion",     db)).toEqual({});
  });

  test("delegates 'defillama' to discoverDefillama", () => {
    const out = runDiscovery("defillama", db);
    expect(out).toEqual({ targets: [], skip_coin_keys: [] });
  });

  test("delegates 'geckoterminal' to discoverGeckoterminal", () => {
    const out = runDiscovery("geckoterminal", db);
    expect(out).toEqual({ targets: [] });
  });
});
