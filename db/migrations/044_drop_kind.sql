-- 044_drop_kind.sql
--
-- Drop the redundant `kind` columns and `transactions_v2.category` now that:
--   - Migration 042 added category_options to bundles (template-driven)
--   - Migration 043 synthesized one transaction_item per unitemized txn,
--     copying category (or kind as fallback) onto the item row
--
-- Columns being dropped:
--   transactions_v2.kind        (added in 037)
--   transactions_v2.category    (added in earliest schema; data now lives on items)
--   transaction_items.kind      (added in 037)
--
-- SQLite 3.35+ supports DROP COLUMN directly. Verified: 3.51.2 is in use.
-- None of these columns are referenced by CHECK constraints in the current
-- table definition (the CHECK on transaction_items.kind was in the original
-- table DDL but migration 043 rebuilt the table — the new DDL retained it,
-- so we must drop the index before the column to avoid that constraint
-- reference blocking the DROP COLUMN).
--
-- Indexes attached to the dropped columns must be removed first.

DROP INDEX IF EXISTS idx_items_kind;
DROP INDEX IF EXISTS idx_txnv2_kind;

ALTER TABLE transactions_v2 DROP COLUMN kind;
ALTER TABLE transactions_v2 DROP COLUMN category;
ALTER TABLE transaction_items DROP COLUMN kind;
