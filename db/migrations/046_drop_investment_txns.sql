-- 046_drop_investment_txns.sql
--
-- Drop the v1 investment_txns table. It was populated from the aggregator's
-- Cashflow.csv (deposit/withdraw rows for manually-tracked assets), but
-- nothing reads it — cashflow comes from postings now. Per
-- V1_RETIREMENT.md, this is the safe-to-drop sibling of transfer_pairs
-- (already gone in migration 027).
--
-- The companion code change (parsers/aggregator.py + ingest.py + helper
-- scripts) lands together with this migration. After this commit:
--   - aggregator ingest no longer reads Cashflow.csv (it had no live readers)
--   - parsers/base.py's InvestmentTxnRow + ParseResult.investment_txns
--     are gone
--   - reconcile.py's account-merge cleanup no longer DELETEs from this
--     table
--   - scripts/wipe_derived.py and the verify_*.py one-shots no longer
--     reference it

DROP TABLE IF EXISTS investment_txns;
