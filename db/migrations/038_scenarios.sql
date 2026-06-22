-- db/migrations/038_scenarios.sql
-- Projections sandbox: named scenarios and their timeline events.
-- scenario_events stores one row per user-placed event (take_loan, invest_cash,
-- rate_reset, market_shock, liquidate, loan_payment_schedule, cashflow_override).
-- Payload shapes are documented in dashboard/shared/types.ts; not enforced here.

CREATE TABLE scenarios (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  notes                  TEXT,
  start_date             TEXT NOT NULL,       -- ISO date, e.g. 2026-04-01
  horizon_months         INTEGER NOT NULL,
  baseline_return_pct    REAL NOT NULL,
  baseline_vol_pct       REAL NOT NULL,
  home_appreciation_pct  REAL NOT NULL,
  mc_enabled             INTEGER NOT NULL DEFAULT 0,
  mc_paths               INTEGER NOT NULL DEFAULT 5000,
  mc_seed                INTEGER,
  comparison_scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE scenario_events (
  scenario_id  TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('take_loan','invest_cash','loan_payment_schedule',
                  'rate_reset','market_shock','liquidate','cashflow_override')),
  at_month     INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (scenario_id, seq)
);

