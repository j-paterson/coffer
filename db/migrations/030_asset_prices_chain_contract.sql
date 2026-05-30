-- asset_prices: add (chain, contract_address) dimensions.
--
-- Pre-this-migration, prices were keyed on symbol alone. Any token with
-- symbol="DEGEN" got priced as real DEGEN, including scam copies at
-- different contracts. New PK is (chain, contract_address, symbol,
-- as_of, source) so pricing is strictly per-token-identity.
--
-- Native tokens (BTC, ETH, SOL, ...) use contract_address='' and
-- chain set to the native chain identifier ('bitcoin', 'ethereum',
-- 'solana', etc., or 'base', 'optimism' etc. for native gas).
--
-- Existing symbol-only rows are dropped — they were unreliable by
-- design. Repopulate via scripts/backfill/defillama_prices.ts.

DROP TABLE IF EXISTS asset_prices;
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
