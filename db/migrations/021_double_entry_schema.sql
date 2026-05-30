-- Double-entry accounting schema (v2).
--
-- Coexists with the legacy `transactions` + `balances` tables during
-- migration. Once the v2 API readers are live and verified, v1 drops.
--
-- Three layers:
--   raw_events       — append-only source-of-truth. Every row / PDF line /
--                      API response entry lands here exactly as received.
--   transactions_v2  — normalized double-entry txn headers.
--   postings         — individual debit/credit legs. SUM(amount) per
--                      transaction must equal 0 per currency.
--
-- Every txn has >= 2 postings; the total across them must net to zero.
-- Unresolved counterparties post to 'equity:unknown-counterparty' so
-- missing data is *visible* rather than silently absorbed.

CREATE TABLE raw_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,        -- 'simplefin','chase-pdf','cointracker',...
  source_file TEXT,                 -- filename / URL fragment (nullable)
  external_id TEXT,                 -- OFX FITID, SimpleFIN txn id, etc.
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload     TEXT NOT NULL,        -- JSON of the original row (audit)
  UNIQUE (source, external_id)
);
CREATE INDEX idx_raw_events_source ON raw_events(source);

CREATE TABLE transactions_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  notes       TEXT,
  tags        TEXT,
  derived_by  TEXT NOT NULL,        -- 'ingest','match:hash','match:bank',...
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_transactions_v2_date ON transactions_v2(date);

CREATE TABLE postings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id     INTEGER NOT NULL REFERENCES transactions_v2(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  payee      TEXT,
  memo       TEXT,
  reconciled INTEGER NOT NULL DEFAULT 0   -- 0=unreconciled, 1=cleared, 2=reconciled
);
CREATE INDEX idx_postings_account ON postings(account_id);
CREATE INDEX idx_postings_txn ON postings(txn_id);

-- Many-to-many: one txn can derive from multiple raw_events (same real
-- event captured by SimpleFIN + Chase CSV + Chase PDF all at once).
CREATE TABLE event_links (
  txn_id INTEGER NOT NULL REFERENCES transactions_v2(id) ON DELETE CASCADE,
  raw_id INTEGER NOT NULL REFERENCES raw_events(id),
  PRIMARY KEY (txn_id, raw_id)
);
CREATE INDEX idx_event_links_raw ON event_links(raw_id);

-- Authoritative balance snapshots. Replaces v1 `balances` semantically.
-- The walker ASSERTS these rather than blindly trusting them, and
-- reports deltas.
CREATE TABLE balance_assertions (
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  as_of        TEXT NOT NULL,
  expected_usd REAL NOT NULL,
  source       TEXT NOT NULL,
  source_file  TEXT,
  PRIMARY KEY (account_id, as_of, source)
);

CREATE TABLE reconciliation_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of      TEXT NOT NULL,
  kind       TEXT NOT NULL,         -- 'assertion_delta','duplicate_merge','transfer_merge','pad'
  detail     TEXT,                   -- JSON blob
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_recon_notes_account ON reconciliation_notes(account_id);

-- Reserved equity accounts. Pre-populated so normalizers always have a
-- target for the "counterparty not yet identified" leg.
INSERT OR IGNORE INTO accounts (id, display_name, institution, type, currency, active, mode)
VALUES
  ('equity:unknown-counterparty', 'Unknown Counterparty',     'Equity', 'alt', 'USD', 1, 'manual'),
  ('equity:opening-balance',      'Opening Balance',          'Equity', 'alt', 'USD', 1, 'manual'),
  ('equity:unreconciled',         'Unreconciled Adjustments', 'Equity', 'alt', 'USD', 1, 'manual');
