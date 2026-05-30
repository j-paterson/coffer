-- 005_payee_location.sql
-- Capture the cleaned payee, memo, and any inferred location data on
-- transactions. SimpleFIN already returns a normalized `payee` field
-- alongside the raw `description`, but our v1 parser threw it away —
-- this migration adds storage and the parser is updated to populate it.
--
-- location_hint is a free-text field with a city/state extracted from
-- the description at ingest time (e.g., "Banff", "Austin TX"). It's a hint
-- for trip detection and the spending UI; not authoritative geocoding.

ALTER TABLE transactions ADD COLUMN payee TEXT;
ALTER TABLE transactions ADD COLUMN memo TEXT;
ALTER TABLE transactions ADD COLUMN location_hint TEXT;

CREATE INDEX IF NOT EXISTS idx_txn_payee ON transactions(payee);
CREATE INDEX IF NOT EXISTS idx_txn_location ON transactions(location_hint);
