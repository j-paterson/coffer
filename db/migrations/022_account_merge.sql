-- Account-level merge: declare that one account is an alias of another.
-- All postings, raw_events, balance_assertions stay attached to their
-- original account_id (audit trail intact). The dashboard sums postings
-- via COALESCE(merged_into, id) so merged accounts roll up.
--
-- Use cases:
--   * coinbase:exchange-bundle (CoinTracker) merged into the user's
--     canonical Coinbase account (e.g. simplefin:ACT-fc3b...)
--   * Multiple kubera:<uuid> entries for the same real wallet, merged
--     into one canonical zerion: account
--   * Chase statement CSV import that creates a duplicate of a SimpleFIN
--     account, merged into the live one
--
-- Set/clear with `finance accounts merge` / `finance accounts unmerge`.
-- A canonical account never has merged_into set on itself (no chains).

ALTER TABLE accounts ADD COLUMN merged_into TEXT REFERENCES accounts(id);
CREATE INDEX IF NOT EXISTS idx_accounts_merged_into ON accounts(merged_into);
