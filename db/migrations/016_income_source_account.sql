-- 016_income_source_account.sql
-- Marks accounts whose disbursements should count as income on the
-- receiving end (e.g., an annuity payout account).
--
-- The cashflow income detector reads this flag to identify recurring
-- income streams that the categorize pipeline tags as 'Transfer'
-- (because they appear as mirrored internal transfers). Without the
-- flag, those disbursements are filtered out of income.

ALTER TABLE accounts ADD COLUMN is_income_source INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_accounts_income_source
  ON accounts(is_income_source) WHERE is_income_source = 1;
