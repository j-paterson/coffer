-- 045_spending_exclusions.sql
--
-- Per-transaction "ignore in spending" flag. Excludes a row from the
-- Spending page's donut, category totals, and category transaction
-- lists. Cashflow detector and balance walks intentionally ignore this
-- column — see docs/superpowers/specs/2026-04-28-ignore-in-spending-design.md.
--
-- Originally authored as 042_spending_exclusions.sql on the
-- feat/ignore-in-spending branch. Renumbered to 045 at merge time
-- because main's 042 slot was taken by 042_bundle_category_options.sql.
ALTER TABLE transactions_v2
  ADD COLUMN excluded_from_spending INTEGER NOT NULL DEFAULT 0;
