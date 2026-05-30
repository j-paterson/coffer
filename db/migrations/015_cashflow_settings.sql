-- 015_cashflow_settings.sql
-- User-overridable monthly cashflow numbers used by the /debt planner.
--
-- Single-row table (singleton). Both columns are nullable: NULL means
-- "use the data-derived estimate". When the user edits a value, we
-- store it and prefer it over the estimate. Setting back to NULL
-- (clear) reverts to the estimate.

CREATE TABLE cashflow_settings (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_income           REAL,
  monthly_required_expense REAL,
  pay_frequency            TEXT,           -- 'monthly'|'semimonthly'|'biweekly'|'weekly'
  notes                    TEXT,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO cashflow_settings (id, pay_frequency) VALUES (1, 'semimonthly');
