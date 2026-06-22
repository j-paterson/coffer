-- User-entered cost basis overrides for crypto positions that can't be
-- reconstructed from the cost-basis importer FIFO or on-chain DEX history.
--
-- When `account_id` is NULL the override applies to all active positions
-- with that canonical symbol; when set, it's scoped to a single account.
-- Account-scoped rows win over symbol-only rows (ORDER BY account_id DESC
-- NULLS LAST at read time).
--
-- The `cost_usd` column is the total basis for the current quantity at
-- the time of entry. We store `quantity_at_entry` too so the override can
-- be scaled proportionally if the position size changes later (sells
-- shrink the remaining basis, additional buys leave it untouched and
-- need a new override).

CREATE TABLE IF NOT EXISTS cost_basis_overrides (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol               TEXT NOT NULL,         -- canonical, uppercased
  account_id           TEXT,                  -- NULL = applies to all accounts
  cost_usd             REAL NOT NULL,         -- basis for the qty at entry time
  quantity_at_entry    REAL,                  -- live qty when user entered basis
  note                 TEXT,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cbo_scope
  ON cost_basis_overrides (symbol, COALESCE(account_id, ''));
