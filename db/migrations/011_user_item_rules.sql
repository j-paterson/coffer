-- 011_user_item_rules.sql
-- User corrections to item categories and the learning loop.
--
-- `category_source` tracks provenance of each item's category so
-- user edits are never overwritten by automated re-classification.
--
-- `user_item_rules` stores keyword→category mappings derived from user
-- retags. When a user assigns "Kodiak Cakes" the category "snacks",
-- the token "kodiak" gets recorded as a learned rule so future items
-- containing "kodiak" auto-classify as "snacks" without an LLM call.

ALTER TABLE transaction_items ADD COLUMN category_source TEXT;

CREATE TABLE user_item_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword         TEXT NOT NULL,
  category        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_item_id  INTEGER,
  hits            INTEGER NOT NULL DEFAULT 0,
  UNIQUE(keyword, category)
);

CREATE INDEX idx_user_rules_keyword ON user_item_rules(keyword);
