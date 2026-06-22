-- 050_goals.sql
--
-- Lightweight sinking-fund goals: named savings targets the user
-- "earmarks" cash toward, parallel to (not constraining) day-to-day
-- spending categories. allocated_amount is a single signed running
-- total — adding money is a positive delta, drawing down is a
-- negative delta. We deliberately don't track each contribution as
-- a row: a goal IS its current state. An audit-trail upgrade can
-- add allocation_events later without touching this table.

CREATE TABLE goals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  target_amount    REAL    NOT NULL CHECK (target_amount > 0),
  allocated_amount REAL    NOT NULL DEFAULT 0,
  due_date         TEXT,                                   -- ISO 'YYYY-MM-DD', nullable
  created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at     TEXT                                     -- nullable; set on archive
);

CREATE INDEX goals_active_idx ON goals (completed_at) WHERE completed_at IS NULL;
