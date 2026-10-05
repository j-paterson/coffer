-- When a provider last returned this account in a successful sync. Every
-- account a run returned gets the same stamp (the run's start), so the
-- latest feed is "accounts sharing the max stamp for that provider". Used to
-- spot accounts that dropped out after an aggregator reconnect (relink).
ALTER TABLE accounts ADD COLUMN last_seen_at TEXT;
