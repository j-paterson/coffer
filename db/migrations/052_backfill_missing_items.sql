-- Backfill transaction_items for transactions created after migration 043.
-- postTransaction previously only inserted an item when category was provided;
-- now it always creates one, but existing rows need the same treatment.

INSERT INTO transaction_items (
  email_id, line_no, name, line_total, category, transaction_v2_id
)
SELECT
  NULL,
  1,
  COALESCE(t.description, ''),
  COALESCE(SUM(p.amount), 0),
  NULL,
  t.id
FROM transactions_v2 t
LEFT JOIN postings p
  ON p.txn_id = t.id AND p.account_id NOT LIKE 'equity:%'
WHERE NOT EXISTS (
  SELECT 1 FROM transaction_items WHERE transaction_v2_id = t.id
)
GROUP BY t.id;
