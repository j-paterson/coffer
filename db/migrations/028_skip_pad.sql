-- skip_pad: when set, pad will not write reconciling postings against
-- this account's assertions, even if a higher-trust source disagrees
-- with the running posting sum. Used for accounts where the postings
-- ARE the source of truth (e.g., coinbase:exchange-bundle, where
-- CoinTracker has every historical trade and any aggregator snapshot
-- is at-best a delayed approximation).

ALTER TABLE accounts ADD COLUMN skip_pad INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_accounts_skip_pad ON accounts(skip_pad);
