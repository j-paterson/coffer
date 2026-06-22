-- 009_item_short_name.sql
-- Amazon product titles are SEO-optimized word salad (brand + every
-- feature + size + package count + marketing adjectives). Unusable as
-- line-item labels in the dashboard.
--
-- `short_name` caches an LLM-generated 2-5 word human description per
-- item. Populated by `finance shorten-items`, which only touches rows
-- where short_name IS NULL. The original `name` stays untouched so we
-- can always compare to what the receipt actually said.

ALTER TABLE transaction_items ADD COLUMN short_name TEXT;
