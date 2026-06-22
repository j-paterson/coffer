-- Cost basis events derived from on-chain DEX activity (Alchemy transfers
-- in `raw_events`), populated by `finance backfill dex-basis`. Each row
-- represents a single swap or disposal event on a single wallet as seen
-- from net token flow within one transaction hash.
--
-- Feeds into the TS-side FIFO cost-basis calculator alongside the cost-basis
-- importer events. To avoid double-counting trades that the cost-basis importer
-- already saw, the FIFO consumer skips derived events for symbols that the
-- cost-basis importer has any history of — the wallet is either entirely
-- importer-tracked (symbol shows up in importer history) or entirely
-- Alchemy-derived (symbol never appeared in the importer).

CREATE TABLE IF NOT EXISTS derived_cost_basis_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash            TEXT NOT NULL,
  chain              TEXT NOT NULL,
  wallet_address     TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,     -- ISO datetime
  received_symbol    TEXT,              -- canonical, uppercased; null = pure disposal
  received_contract  TEXT,
  received_quantity  REAL,
  sent_symbol        TEXT,              -- canonical, uppercased; null = pure receipt
  sent_contract      TEXT,
  sent_quantity      REAL,
  cost_basis_usd     REAL,              -- USD value of sent side (null when un-priceable)
  proceeds_usd       REAL,              -- USD value of received side (null when un-priceable)
  confidence         TEXT NOT NULL DEFAULT 'swap',
  computed_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Partial-expression UNIQUE indexes are the SQLite-friendly way to uniquify
-- on COALESCE(col, '') — a table-level UNIQUE constraint can't embed
-- expressions, but an index can.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dcbe_unique
  ON derived_cost_basis_events (
    tx_hash, chain, wallet_address,
    COALESCE(received_symbol, ''), COALESCE(sent_symbol, '')
  );
CREATE INDEX IF NOT EXISTS idx_dcbe_symbol
  ON derived_cost_basis_events (received_symbol, occurred_at);
CREATE INDEX IF NOT EXISTS idx_dcbe_sent
  ON derived_cost_basis_events (sent_symbol, occurred_at);
