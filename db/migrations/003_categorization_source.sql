-- 003_categorization_source.sql
-- Adds an audit column tracking which rule (or which mechanism) assigned a
-- category to each transaction. NULL means uncategorized; 'manual' is
-- reserved for future hand-edits via UI; otherwise it stores the rule name
-- from rules.yaml so "why did this get tagged X" is greppable.

ALTER TABLE transactions
  ADD COLUMN categorization_source TEXT;

CREATE INDEX IF NOT EXISTS idx_txn_cat_source
  ON transactions(categorization_source);
