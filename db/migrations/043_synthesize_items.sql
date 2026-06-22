-- 043_synthesize_items.sql
--
-- Two goals:
--   1. Relax transaction_items.email_id from NOT NULL to nullable, so
--      synthesized items (which have no email source) can be inserted.
--      SQLite doesn't support DROP NOT NULL directly, so we rebuild the table.
--   2. For every transactions_v2 row that has no transaction_items, insert
--      one synthesized item carrying the txn's category (or kind if category
--      is null). Multi-item txns are left untouched.
--
-- Column inventory verified via:
--   PRAGMA table_info(transaction_items)  (after applying all prior migrations)
--
--   cid  name               type     notnull  pk
--     0  id                 INTEGER     0      1   (AUTOINCREMENT)
--     1  email_id           TEXT        1      0   ← relaxed to nullable here
--     2  transaction_id     TEXT        0      0
--     3  line_no            INTEGER     1      0
--     4  name               TEXT        1      0
--     5  quantity           REAL        0      0
--     6  unit_price         REAL        0      0
--     7  line_total         REAL        0      0
--     8  raw                TEXT        0      0
--     9  category           TEXT        0      0
--    10  short_name         TEXT        0      0
--    11  subcategory        TEXT        0      0
--    12  category_source    TEXT        0      0
--    13  transaction_v2_id  INTEGER     0      0
--    14  kind               TEXT        0      0

-- ─── Step 1: rebuild table with email_id nullable ─────────────────────────

CREATE TABLE transaction_items_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id         TEXT REFERENCES emails(id) ON DELETE CASCADE,  -- nullable
  transaction_id   TEXT REFERENCES transactions(id),
  line_no          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  quantity         REAL,
  unit_price       REAL,
  line_total       REAL,
  raw              TEXT,
  category         TEXT,
  short_name       TEXT,
  subcategory      TEXT,
  category_source  TEXT,
  transaction_v2_id INTEGER REFERENCES transactions_v2(id),
  kind             TEXT CHECK (kind IN ('material', 'labor'))
);

INSERT INTO transaction_items_new
  SELECT id, email_id, transaction_id, line_no, name, quantity, unit_price,
         line_total, raw, category, short_name, subcategory, category_source,
         transaction_v2_id, kind
  FROM transaction_items;

DROP TABLE transaction_items;
ALTER TABLE transaction_items_new RENAME TO transaction_items;

-- Recreate all indexes that existed on the old table
CREATE INDEX idx_items_email        ON transaction_items(email_id);
CREATE INDEX idx_items_txn          ON transaction_items(transaction_id);
CREATE INDEX idx_items_category     ON transaction_items(category);
CREATE INDEX idx_items_subcategory  ON transaction_items(subcategory);
CREATE INDEX idx_transaction_items_v2_txn ON transaction_items(transaction_v2_id);
CREATE INDEX idx_items_kind         ON transaction_items(kind);

-- ─── Step 2: backfill item.category from item.kind ────────────────────────
--
-- Pre-existing items have two signals: transaction_items.kind (an explicit
-- bundle-affinity marker like 'material'/'labor') and transaction_items.category
-- (a generic auto-classification, sometimes legacy values like 'home_renovation'
-- or 'fees'). When kind is set it is the more reliable bundle signal, so it
-- overwrites category. Migration 044 drops the kind column right after this.
--
-- Map kind values to the storage form the API normalises to (lowercase,
-- plural for 'material'), so they line up with bundle.category_options after
-- a case-insensitive compare.

UPDATE transaction_items
   SET category = CASE kind
                    WHEN 'material' THEN 'materials'
                    WHEN 'labor'    THEN 'labor'
                    ELSE kind
                  END
 WHERE kind IS NOT NULL;

-- ─── Step 3: synthesize one item per unitemized txn ───────────────────────
--
-- For each transactions_v2 row with no existing transaction_items, insert
-- one row. line_total = SUM of non-equity postings (equity legs balance the
-- books and should not count toward the spend amount).
-- COALESCE(t.category, t.kind) is the fallback chain: category wins, kind
-- is the backup for rows where category was never set.

INSERT INTO transaction_items (
  email_id, line_no, name, line_total, category, subcategory, transaction_v2_id
)
SELECT
  NULL,
  1,
  COALESCE(t.description, ''),
  COALESCE(SUM(p.amount), 0),
  COALESCE(t.category, t.kind),
  NULL,
  t.id
FROM transactions_v2 t
LEFT JOIN postings p
  ON p.txn_id = t.id AND p.account_id NOT LIKE 'equity:%'
WHERE NOT EXISTS (
  SELECT 1 FROM transaction_items WHERE transaction_v2_id = t.id
)
GROUP BY t.id;
