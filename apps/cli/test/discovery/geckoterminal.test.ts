import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "@coffer/ledger/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverGeckoterminal } from "../../src/discovery/geckoterminal";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../../../db/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe("discovery/geckoterminal", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("returns targets: [] when positions table is empty", () => {
    expect(discoverGeckoterminal(db).targets).toEqual([]);
  });

  test("returns targets: [] when only btc/empty-contract rows exist", () => {
    db.exec(`
      INSERT INTO accounts (id, display_name, institution, type, mode)
        VALUES ('a1', 'btc', 'self', 'crypto', 'live');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'BTC', 'bitcoin', '');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'ETH', 'ethereum', '');
    `);
    expect(discoverGeckoterminal(db).targets).toEqual([]);
  });

  test("returns one target per EVM contract row (no extra fields)", () => {
    db.exec(`
      INSERT INTO accounts (id, display_name, institution, type, mode)
        VALUES ('a1', 'eth wallet', 'self', 'crypto', 'live');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'USDC', 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'WETH', 'ethereum', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'BTC', 'bitcoin', '');
    `);
    const { targets } = discoverGeckoterminal(db);
    expect(targets.length).toBe(2);
    const symbols = targets.map((t) => t.symbol).sort();
    expect(symbols).toEqual(["USDC", "WETH"]);
    expect(targets.every((t) => t.chain === "ethereum")).toBe(true);
    expect(targets.every((t) => /^0x[a-fA-F0-9]{40}$/.test(t.contract))).toBe(true);
    // No `since`, `from`, `to` keys — GeckoTerminalTarget is .strict().
    for (const t of targets) {
      expect(Object.keys(t).sort()).toEqual(["chain", "contract", "symbol"]);
    }
  });

  test("dedupes identical (symbol, chain, contract) rows via SELECT DISTINCT", () => {
    db.exec(`
      INSERT INTO accounts (id, display_name, institution, type, mode)
        VALUES ('a1', 'wallet a', 'self', 'crypto', 'live'),
               ('a2', 'wallet b', 'self', 'crypto', 'live');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'USDC', 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
               ('a2', 'crypto', 'USDC', 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    `);
    expect(discoverGeckoterminal(db).targets.length).toBe(1);
  });
});
