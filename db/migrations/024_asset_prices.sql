-- asset_prices: canonical historical price store, indexed by symbol + date.
--
-- Multiple price sources can populate this (CoinGecko, yfinance, Zerion
-- fungible chart). Reads pick the highest-trust source per (symbol, date).
--
-- Symbol-only keying (not per-account, not per-chain) — a price for ETH
-- on date D is the same regardless of which wallet holds it. Where a
-- symbol has bridged variants (USDC.e), we treat the bridged variant as
-- a separate symbol upstream.
--
-- The qty-walk backfill multiplies cumulative quantity per (account,
-- symbol, date) by the highest-trust price for that (symbol, date).
-- Eventually replaces the ad-hoc "infer price from holdings.value_usd /
-- quantity" pattern in backfill_quantity_walk.py.

CREATE TABLE asset_prices (
  symbol TEXT NOT NULL,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  price_usd REAL NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, as_of, source)
);

CREATE INDEX idx_asset_prices_symbol_date ON asset_prices(symbol, as_of);
