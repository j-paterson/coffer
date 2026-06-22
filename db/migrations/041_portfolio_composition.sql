-- db/migrations/041_portfolio_composition.sql
-- Persist user-edited PortfolioComposition with the scenario.
-- Stored as JSON; the shared/types.ts PortfolioComposition shape is authoritative.
-- NULL means "use the legacy single-asset path derived from baseline_return_pct".

ALTER TABLE scenarios ADD COLUMN composition_json TEXT;
