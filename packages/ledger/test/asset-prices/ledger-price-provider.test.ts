import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { LedgerPriceProvider } from "../../src/asset-prices/ledger-price-provider";

function seed(db: Database, rows: Array<{
  chain?: string;
  contract_address?: string;
  symbol: string;
  as_of: string;
  source: string;
  price_usd: number;
}>) {
  const stmt = db.prepare(
    `INSERT INTO asset_prices (chain, contract_address, symbol, as_of, source, price_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(r.chain ?? "", r.contract_address ?? "", r.symbol, r.as_of, r.source, r.price_usd);
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE asset_prices (
      chain TEXT NOT NULL DEFAULT '',
      contract_address TEXT NOT NULL DEFAULT '',
      symbol TEXT NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT NOT NULL,
      price_usd REAL NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain, contract_address, symbol, as_of, source)
    );
    CREATE INDEX asset_prices_lookup ON asset_prices (chain, contract_address, as_of);
  `);
  return db;
}

describe("LedgerPriceProvider — exact-date lookup", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("returns price on exact date match", async () => {
    seed(db, [{ chain: "ethereum", contract_address: "", symbol: "USDC", as_of: "2024-06-15", source: "defillama", price_usd: 1.0 }]);
    const p = new LedgerPriceProvider(db);
    const r = await p.getPrice({ symbol: "USDC", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r).toEqual({ price_usd: 1.0, as_of: "2024-06-15", source: "defillama" });
  });

  test("source-priority orders results: defillama beats manual", async () => {
    seed(db, [
      { chain: "ethereum", symbol: "USDC", as_of: "2024-06-15", source: "manual",    price_usd: 99 },
      { chain: "ethereum", symbol: "USDC", as_of: "2024-06-15", source: "defillama", price_usd: 1 },
    ]);
    const p = new LedgerPriceProvider(db);
    const r = await p.getPrice({ symbol: "USDC", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r?.source).toBe("defillama");
    expect(r?.price_usd).toBe(1);
  });

  test("returns null when no row matches", async () => {
    const p = new LedgerPriceProvider(db);
    const r = await p.getPrice({ symbol: "ZZZ", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r).toBeNull();
  });
});

describe("LedgerPriceProvider — nearest neighbor", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("returns ±N day neighbor when exact missing (within window)", async () => {
    seed(db, [{ chain: "ethereum", symbol: "USDC", as_of: "2024-06-13", source: "defillama", price_usd: 1.0 }]);
    const p = new LedgerPriceProvider(db);
    const r = await p.getPrice({ symbol: "USDC", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r).toEqual({ price_usd: 1.0, as_of: "2024-06-13", source: "defillama" });
  });

  test("picks the closest date when multiple neighbors exist", async () => {
    seed(db, [
      { chain: "ethereum", symbol: "USDC", as_of: "2024-06-10", source: "defillama", price_usd: 0.5 }, // 5 days off
      { chain: "ethereum", symbol: "USDC", as_of: "2024-06-13", source: "defillama", price_usd: 1.0 }, // 2 days off
    ]);
    const p = new LedgerPriceProvider(db);
    const r = await p.getPrice({ symbol: "USDC", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r?.as_of).toBe("2024-06-13");
    expect(r?.price_usd).toBe(1.0);
  });

  test("returns null when no row falls within ±7 day window", async () => {
    seed(db, [{ chain: "ethereum", symbol: "USDC", as_of: "2024-06-01", source: "defillama", price_usd: 1.0 }]);
    const p = new LedgerPriceProvider(db);
    const r = await p.getPrice({ symbol: "USDC", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r).toBeNull();
  });

  test("respects custom nearestNeighborDays", async () => {
    seed(db, [{ chain: "ethereum", symbol: "USDC", as_of: "2024-06-13", source: "defillama", price_usd: 1.0 }]);
    const p = new LedgerPriceProvider(db, { nearestNeighborDays: 1 }); // 2 days off is outside
    const r = await p.getPrice({ symbol: "USDC", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r).toBeNull();
  });
});

describe("LedgerPriceProvider — custom source priority + key matching", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("honors custom sourcePriority ordering", async () => {
    seed(db, [
      { chain: "ethereum", symbol: "USDC", as_of: "2024-06-15", source: "defillama", price_usd: 1 },
      { chain: "ethereum", symbol: "USDC", as_of: "2024-06-15", source: "manual",    price_usd: 99 },
    ]);
    const p = new LedgerPriceProvider(db, { sourcePriority: ["manual", "defillama"] });
    const r = await p.getPrice({ symbol: "USDC", chain: "ethereum", contract_address: "", as_of: "2024-06-15" });
    expect(r?.source).toBe("manual");
    expect(r?.price_usd).toBe(99);
  });

  test("prefers (chain, contract_address) match over symbol-only match when both exist", async () => {
    // Native BTC row (chain='bitcoin', contract='') with symbol='BTC' vs. a scammy
    // ERC-20 with symbol='BTC' on ethereum. Caller is asking for the bitcoin row.
    seed(db, [
      { chain: "bitcoin",  contract_address: "",                                            symbol: "BTC", as_of: "2024-06-15", source: "defillama", price_usd: 65000 },
      { chain: "ethereum", contract_address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", symbol: "BTC", as_of: "2024-06-15", source: "defillama", price_usd: 0.0001 },
    ]);
    const p = new LedgerPriceProvider(db);
    const r = await p.getPrice({ symbol: "BTC", chain: "bitcoin", contract_address: "", as_of: "2024-06-15" });
    expect(r?.price_usd).toBe(65000);
  });
});
