-- emails.transaction_id was keyed off the v1 transactions table. As we
-- retire v1 we add a parallel transaction_v2_id pointing at
-- transactions_v2.id (INTEGER), backfilled from the
-- raw_events.external_id ↔ event_links bridge. Same shape as migration
-- 026 used for transaction_items.
--
-- ON DELETE SET NULL: emails are immutable artifacts (raw .eml stored on
-- disk). If reconciliation deletes a v2 txn, we want to retain the email
-- record and simply drop its stale pointer rather than cascade-delete
-- or block the txn cleanup.

ALTER TABLE emails ADD COLUMN transaction_v2_id INTEGER
  REFERENCES transactions_v2(id) ON DELETE SET NULL;
CREATE INDEX idx_emails_v2_txn ON emails(transaction_v2_id);

UPDATE emails
SET transaction_v2_id = (
  SELECT el.txn_id FROM raw_events re
  JOIN event_links el ON el.raw_id = re.id
  WHERE re.external_id = emails.transaction_id
  LIMIT 1
)
WHERE transaction_id IS NOT NULL;
