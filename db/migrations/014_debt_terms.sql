-- 014_debt_terms.sql
-- Per-credit-account terms used by the /debt repayment planner.
-- One row per credit account that the user has provided terms for.
--
-- Why a side table: most fields are credit-card-specific (APR, minimum
-- payment formula, statement day) and don't belong on the generic
-- accounts table. The relationship is 1:1 with credit accounts.
--
-- promo_balance + promo_apr + promo_expires_at model deferred-interest
-- offers like Chase's "Equal Pay Promo": a portion of the balance is
-- effectively 0% APR until a date, then snaps to the regular APR.
-- The planner uses these to (a) compute effective interest correctly
-- and (b) warn when the promo period is closing.

CREATE TABLE debt_terms (
  account_id          TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  apr                 REAL NOT NULL,         -- annual rate, e.g. 0.2349 for 23.49%
  min_payment_pct     REAL,                  -- typical: 0.01-0.02 (1-2% of balance)
  min_payment_floor   REAL,                  -- typical: $25-40 minimum
  promo_balance       REAL,                  -- portion of balance at promo APR
  promo_apr           REAL,                  -- e.g. 0.0 for a 0% offer
  promo_expires_at    TEXT,                  -- ISO date when promo ends
  notes               TEXT,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
