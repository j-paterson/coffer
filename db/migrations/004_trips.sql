-- 004_trips.sql
-- Trips group travel-tagged transactions into auto-detected clusters with
-- a name, date range, and rolled-up total. Trip detection runs as
-- `finance detect-trips` and is fully re-runnable.
--
-- Design choice for v1: a trip's total only includes transactions actually
-- categorized as Travel. Pulling in *all* spending within the date window
-- produces too many false positives (Amazon orders shipping home, recurring
-- bills, restaurants after returning). The dashboard can show "other
-- spending in this date range" as a separate section later.

CREATE TABLE trips (
  id           TEXT PRIMARY KEY,            -- short hash, e.g. "trip-a3f9c2"
  slug         TEXT NOT NULL,               -- e.g. "banff-feb-2026"
  name         TEXT NOT NULL,               -- human label, e.g. "Banff Feb 2026"
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  total_usd    REAL NOT NULL DEFAULT 0,
  txn_count    INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trips_dates ON trips(start_date, end_date);

ALTER TABLE transactions
  ADD COLUMN trip_id TEXT REFERENCES trips(id);

CREATE INDEX idx_txn_trip ON transactions(trip_id);
