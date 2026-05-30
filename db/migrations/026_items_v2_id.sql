-- transaction_items.transaction_id was keyed off the v1 transactions
-- table id. As we retire v1 we add a parallel transaction_v2_id that
-- points at transactions_v2.id (an INTEGER), backfilled from the
-- raw_events.external_id ↔ event_links bridge. v1 transaction_id stays
-- in place during the transition; readers can prefer transaction_v2_id.

ALTER TABLE transaction_items ADD COLUMN transaction_v2_id INTEGER REFERENCES transactions_v2(id);
CREATE INDEX idx_transaction_items_v2_txn ON transaction_items(transaction_v2_id);

UPDATE transaction_items
SET transaction_v2_id = (
  SELECT el.txn_id FROM raw_events re
  JOIN event_links el ON el.raw_id = re.id
  WHERE re.external_id = transaction_items.transaction_id
  LIMIT 1
)
WHERE transaction_id IS NOT NULL;
