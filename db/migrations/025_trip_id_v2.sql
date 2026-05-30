-- Mirror the v1 transactions.trip_id column on transactions_v2 so trip
-- detection can run against the postings ledger and label v2 rows with
-- their trip cluster id.
ALTER TABLE transactions_v2 ADD COLUMN trip_id TEXT;
CREATE INDEX idx_transactions_v2_trip_id ON transactions_v2(trip_id);
