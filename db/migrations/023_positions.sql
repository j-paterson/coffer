-- Position-level identity for asset holdings.
--
-- The v1 `holdings` table keys on (account_id, as_of, symbol) with
-- INSERT-OR-REPLACE — multiple sources writing the same key silently
-- clobber each other. This loses Zerion vs Alchemy vs aggregator disagreement
-- and offers no audit trail.
--
-- The new model splits identity from observation:
--
--   positions          — one stable row per (account, chain, contract, symbol)
--                         — "this is ETH at 0x86d6 on Base in your Coinbase wallet"
--   position_snapshots — every (source, date) reading on that position
--                         — query picks highest-trust source per date
--
-- For off-chain assets (brokerage holdings, exchange wallets) chain and
-- contract_address are NULL; identity is just (account_id, symbol).

-- Off-chain positions use chain='' and contract_address='' (empty
-- strings, not NULL) so the composite UNIQUE constraint actually
-- prevents duplicates — NULLs in SQLite UNIQUE behave as distinct.
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT '',
  contract_address TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL,
  asset_class TEXT,
  UNIQUE(account_id, chain, contract_address, symbol)
);

CREATE INDEX idx_positions_account ON positions(account_id);
CREATE INDEX idx_positions_symbol ON positions(symbol);

CREATE TABLE position_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  quantity REAL,
  value_usd REAL NOT NULL,
  cost_basis REAL,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(position_id, as_of, source)
);

CREATE INDEX idx_pos_snapshots_date ON position_snapshots(as_of);
CREATE INDEX idx_pos_snapshots_position ON position_snapshots(position_id);
