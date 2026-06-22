-- 013_account_name_override.sql
-- Per-account display name override. When set, takes precedence over
-- display_name everywhere the account is rendered. Two ways it gets
-- populated:
--
--   1. Auto, on Zerion sync: nicknames inherited from the matching
--      aggregator asset's name ("MetaMask - Ethereum 0x…") so
--      live Zerion accounts read like the user's own labels rather
--      than the auto-generated "Base 0x…".
--
--   2. Manual, via PATCH /api/accounts/:id from the dashboard.

ALTER TABLE accounts ADD COLUMN display_name_override TEXT;
