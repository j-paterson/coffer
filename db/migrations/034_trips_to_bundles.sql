-- Generalize "trips" into "bundles" — a bundle is any named collection of
-- transactions: trips, home renovations, projects, etc.

ALTER TABLE trips RENAME TO bundles;
ALTER TABLE bundles ADD COLUMN type TEXT NOT NULL DEFAULT 'trip';

-- The FK columns in transactions / transactions_v2 stay as trip_id for now
-- (they reference bundles.id). Renaming columns in SQLite is costly and the
-- internal name doesn't leak to the UI.

CREATE INDEX IF NOT EXISTS idx_bundles_type ON bundles(type);
