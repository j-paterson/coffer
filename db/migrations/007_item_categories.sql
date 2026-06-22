-- 007_item_categories.sql
-- Adds a `category` column to transaction_items so the dashboard can
-- drill into "what kind of things am I buying" — the secondary breakdown
-- under Shopping requested in milestone 8b.1.
--
-- Classification is produced by `finance classify-items`, which uses a
-- keyword rules file (v1). The column is nullable so unclassified items
-- stay visible and a later pass (LLM classifier) can backfill without
-- a schema change.

ALTER TABLE transaction_items ADD COLUMN category TEXT;

CREATE INDEX IF NOT EXISTS idx_items_category ON transaction_items(category);
