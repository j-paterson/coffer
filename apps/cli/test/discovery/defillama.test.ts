import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "@coffer/ledger/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverDefillama } from "../../src/discovery/defillama";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../../../db/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe("discovery/defillama", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("returns targets: [] when positions table is empty", () => {
    expect(discoverDefillama(db).targets).toEqual([]);
  });

  test("returns one target per (symbol, chain, contract) row in positions", () => {
    db.exec(`
      INSERT INTO accounts (id, display_name, institution, type, mode)
        VALUES ('a1', 'eth wallet', 'self', 'crypto', 'live');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'ETH', 'ethereum', '');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'USDC', 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    `);
    const { targets } = discoverDefillama(db);
    expect(targets.length).toBe(2);
    const eth = targets.find((t) => t.symbol === "ETH");
    expect(eth).toEqual({ symbol: "ETH", chain: "ethereum", contract: "", since: null });
    const usdc = targets.find((t) => t.symbol === "USDC");
    expect(usdc).toEqual({
      symbol: "USDC",
      chain: "ethereum",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      since: null,
    });
  });

  test("populates `since` from MIN(transactions_v2.date) via postings.txn_id", () => {
    db.exec(`
      INSERT INTO accounts (id, display_name, institution, type, mode)
        VALUES ('a1', 'eth wallet', 'self', 'crypto', 'live');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'ETH', 'ethereum', '');
      INSERT INTO transactions_v2 (date, derived_by) VALUES ('2023-04-05', 'ingest');
      INSERT INTO transactions_v2 (date, derived_by) VALUES ('2024-01-01', 'ingest');
      INSERT INTO postings (txn_id, account_id, amount, currency)
        VALUES (1, 'a1', 1.0, 'USD');
      INSERT INTO postings (txn_id, account_id, amount, currency)
        VALUES (2, 'a1', 2.0, 'USD');
    `);
    const { targets } = discoverDefillama(db);
    expect(targets.length).toBe(1);
    expect(targets[0]!.since).toBe("2023-04-05");
  });

  test("excludes non-crypto positions", () => {
    db.exec(`
      INSERT INTO accounts (id, display_name, institution, type, mode)
        VALUES ('a1', 'brokerage', 'self', 'brokerage', 'live');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'equity', 'AAPL', '', '');
    `);
    expect(discoverDefillama(db).targets).toEqual([]);
  });
});
