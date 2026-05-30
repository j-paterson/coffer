-- db/migrations/039_tax_profile.sql
-- Single-row tax configuration (same pattern as cashflow_settings).
-- Used by the projections engine to model §163(d) investment interest expense,
-- the NII cap, the LTCG inclusion election, and LTCG/qualified dividend tax.

CREATE TABLE tax_profile (
  id                                  INTEGER PRIMARY KEY CHECK (id = 1),
  marginal_ordinary_rate              REAL NOT NULL,
  ltcg_rate                           REAL NOT NULL,
  qualified_div_rate                  REAL NOT NULL,
  ltcg_election                       INTEGER NOT NULL DEFAULT 0,
  ordinary_investment_income_monthly  REAL NOT NULL DEFAULT 0,
  updated_at                          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
