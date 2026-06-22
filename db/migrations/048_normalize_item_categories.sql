-- 048_normalize_item_categories.sql
--
-- Collapse legacy mixed-case category and subcategory values on
-- transaction_items into the canonical form used by every current
-- writer: LOWER + TRIM + hyphens-to-underscores.
--
-- Symptoms before this migration:
--   - The Spending page dropdown showed "Restaurants" and "restaurants"
--     as separate buckets (and likewise Pets, Software, Travel, ...),
--   - GROUP BY i.category split each pair's totals across two rows so
--     the lowercase variant looked empty under the capitalized parent.
--
-- All the mixed-case rows have category_source = NULL — they predate
-- the canonicalization the API and email pipeline now apply on every
-- write (see api/src/routes/items.ts and emails/aggregate.py). Newer
-- writers all normalize, so this is a one-shot data fix.
--
-- The data audit showed no internal whitespace in any value and a
-- single hyphenated category ('investment-loss'); LOWER + TRIM with
-- a single hyphen→underscore replace covers every observed case.

UPDATE transaction_items
SET category = REPLACE(LOWER(TRIM(category)), '-', '_')
WHERE category IS NOT NULL
  AND category != ''
  AND category != REPLACE(LOWER(TRIM(category)), '-', '_');

UPDATE transaction_items
SET subcategory = REPLACE(LOWER(TRIM(subcategory)), '-', '_')
WHERE subcategory IS NOT NULL
  AND subcategory != ''
  AND subcategory != REPLACE(LOWER(TRIM(subcategory)), '-', '_');
