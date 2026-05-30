-- 010_item_subcategory.sql
-- Split item categorization into a two-tier system.
--
--   subcategory  = fine-grained LLM label for what this specific item is
--                  ("home_lighting", "fruits", "camping_equipment", ...)
--                  Written by `finance classify-items`.
--
--   category     = canonical broad bucket this subcategory rolls up to
--                  ("home", "grocery", "outdoors", ...)
--                  Written by `finance aggregate-categories`, which asks
--                  an LLM to cluster all distinct subcategories into a
--                  smaller stable set.
--
-- The dashboard groups on `category` for the donut slices and shows
-- `subcategory` for the drill-down, so label fragmentation in the fine-
-- grained column doesn't pollute the top-level view.

ALTER TABLE transaction_items ADD COLUMN subcategory TEXT;

CREATE INDEX IF NOT EXISTS idx_items_subcategory ON transaction_items(subcategory);
