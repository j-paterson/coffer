-- 047_drop_v1_tables.sql
--
-- Drop the last three v1 tables: balances, holdings, transactions.
-- Per V1_RETIREMENT.md, the v2 replacements have been carrying live
-- traffic for a while:
--
--   v1 table       -> v2 replacement
--   balances       -> balance_assertions       (migration 021)
--   holdings       -> positions + position_snapshots (migration 023)
--   transactions   -> transactions_v2 + postings (migration 021)
--
-- Companion code changes that land with this migration:
--   - backfill_quantity_walk.py reads asset prices from
--     position_snapshots instead of holdings (the last live reader)
--   - parsers/zerion.py + parsers/alchemy.py + ingest.py no longer
--     dual-write to the v1 tables
--   - parsers/zerion.py now writes the live wallet total to
--     balance_assertions(source='zerion') — closing a v2 gap that the
--     audit found while removing _upsert_balance
--   - scripts/check_reconcile.py + verify_ingest.py + verify_sync.py
--     deleted (v1-era one-shot diagnostics)
--
-- Two surviving tables hold vestigial FK columns pointing at v1
-- transactions. The data was migrated to transaction_v2_id (migrations
-- 026 + 032), and no live reader consults the v1 column. They have to
-- come out before transactions itself, otherwise SQLite refuses to
-- INSERT into emails or transaction_items (the FK lookup fails when
-- the target table doesn't exist).
--
-- Drop the indexes first — SQLite refuses to DROP COLUMN if any index
-- still references it.

DROP INDEX IF EXISTS idx_emails_txn;
DROP INDEX IF EXISTS idx_items_txn;

ALTER TABLE emails DROP COLUMN transaction_id;
ALTER TABLE transaction_items DROP COLUMN transaction_id;

-- All v1 indexes drop with the table. SQLite's sqlite_autoindex rows
-- for the PKs go too. No FK fan-out needed: nothing else references
-- these.

DROP TABLE IF EXISTS holdings;
DROP TABLE IF EXISTS balances;
DROP TABLE IF EXISTS transactions;
