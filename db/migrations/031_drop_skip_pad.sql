-- Drop the accounts.skip_pad column.
--
-- walkV2 no longer consults it (unified rule: max(postings-with-anchors,
-- mtm-snapshot-sum) per canonical). Summary + accounts_v2 routes were
-- migrated to the unified walker earlier. CLI subcommand
-- `finance accounts skip-pad` has been removed.
--
-- SQLite supports DROP COLUMN since 3.35 (2021).

DROP INDEX IF EXISTS idx_accounts_skip_pad;
ALTER TABLE accounts DROP COLUMN skip_pad;
