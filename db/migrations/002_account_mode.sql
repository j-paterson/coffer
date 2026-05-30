-- 002_account_mode.sql
-- Adds a `mode` column to accounts distinguishing 'live' (populated by a
-- continuous sync source like SimpleFIN) from 'manual' (placeholder data
-- imported from Kubera snapshots or entered by hand).
--
-- Manual entries are treated as stale in the UI and are deleted (not
-- archived) when a live source starts providing the same account.

ALTER TABLE accounts
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live', 'manual'));

-- Backfill: existing Kubera-prefixed accounts are all manual.
UPDATE accounts SET mode = 'manual' WHERE id LIKE 'kubera:%';

-- Also un-archive any Kubera accounts that were previously marked inactive
-- by the old reconcile path. The new reconcile path DELETEs instead, so we
-- want a clean slate. (Idempotent — re-running archives on next sync.)
UPDATE accounts SET active = 1 WHERE id LIKE 'kubera:%' AND active = 0;

CREATE INDEX IF NOT EXISTS idx_accounts_mode ON accounts(mode);
