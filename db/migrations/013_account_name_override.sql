-- 013_account_name_override.sql
-- Per-account display name override. When set, takes precedence over
-- display_name everywhere the account is rendered. Two ways it gets
-- populated:
--
--   1. Auto, on Zerion sync: nicknames inherited from the matching
--      Kubera asset's name ("MetaMask - Ethereum 0xb36c...1af2") so
--      live Zerion accounts read like the user's own labels rather
--      than the auto-generated "Base 0xb36c…1af2".
--
--   2. Manual, via PATCH /api/accounts/:id from the dashboard.

ALTER TABLE accounts ADD COLUMN display_name_override TEXT;
