-- 049_coerce_item_amounts.sql
--
-- Coerce legacy text-typed values in transaction_items numeric columns
-- (line_total, unit_price, quantity) to REAL or NULL.
--
-- Symptoms before this migration:
--   - 101 rows had "$X.XX" / "" stored verbatim instead of parsed numbers
--     (SQLite's lax typing accepted strings into REAL columns).
--   - The Spending donut showed $0 for ~17 categories because
--     SUM(line_total) treats "" as 0 and CAST("$8.58" AS REAL) is 0.
--   - Affected categories: home_hardware, home_appliance, electronics,
--     pets, grocery, drinks, ... (~$5,400 in spending invisible).
--
-- Older email parsings stored the raw LLM output; the current parser
-- uses _parse_amount/_parse_int which already returns REAL or None.
-- This is a one-shot data fix; new ingestions go through the parser.
--
-- Strategy: for each row whose column is text-typed, strip "$" and ","
-- then CAST to REAL. CAST(text AS REAL) yields 0 for non-numeric
-- prefixes, so first NULLIF the empty string. SQLite's permissive CAST
-- truncates trailing junk ("2.99/month" → 2.99), which is what we want.

UPDATE transaction_items
SET line_total = CASE
    WHEN typeof(line_total) != 'text' THEN line_total
    WHEN REPLACE(REPLACE(line_total, '$', ''), ',', '') = '' THEN NULL
    ELSE CAST(REPLACE(REPLACE(line_total, '$', ''), ',', '') AS REAL)
  END
WHERE typeof(line_total) = 'text';

UPDATE transaction_items
SET unit_price = CASE
    WHEN typeof(unit_price) != 'text' THEN unit_price
    WHEN REPLACE(REPLACE(unit_price, '$', ''), ',', '') = '' THEN NULL
    ELSE CAST(REPLACE(REPLACE(unit_price, '$', ''), ',', '') AS REAL)
  END
WHERE typeof(unit_price) = 'text';

UPDATE transaction_items
SET quantity = CASE
    WHEN typeof(quantity) != 'text' THEN quantity
    WHEN TRIM(quantity) = '' THEN NULL
    ELSE CAST(quantity AS REAL)
  END
WHERE typeof(quantity) = 'text';
