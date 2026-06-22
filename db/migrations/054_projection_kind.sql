-- db/migrations/054_projection_kind.sql
--
-- Scope saved scenarios to a projection kind so future projections
-- (retirement, mortgage) can save their own scenarios without
-- colliding with HELOC's. Existing rows backfill as 'heloc'.

ALTER TABLE scenarios ADD COLUMN projection_kind TEXT NOT NULL DEFAULT 'heloc';
