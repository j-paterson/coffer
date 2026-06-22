-- 001_init.sql
-- Initial schema: accounts, transactions, balances, holdings, investment_txns

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  institution   TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN
                  ('credit','checking','savings','brokerage',
                   'retirement','crypto','alt','manual')),
  currency      TEXT NOT NULL DEFAULT 'USD',
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  date          TEXT NOT NULL,
  amount        REAL NOT NULL,
  description   TEXT NOT NULL,
  merchant      TEXT,
  category      TEXT,
  subcategory   TEXT,
  source_file   TEXT NOT NULL,
  imported_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes         TEXT,
  tags          TEXT
);

CREATE INDEX idx_txn_date     ON transactions(date);
CREATE INDEX idx_txn_account  ON transactions(account_id);
CREATE INDEX idx_txn_category ON transactions(category);

CREATE TABLE balances (
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  as_of         TEXT NOT NULL,
  value_usd     REAL NOT NULL,
  source        TEXT NOT NULL,
  PRIMARY KEY (account_id, as_of, source)
);

CREATE INDEX idx_bal_as_of ON balances(as_of);

-- symbol is NOT NULL with '' sentinel because SQLite allows NULLs in PRIMARY KEY
-- columns, which would let duplicate NULL-symbol rows slip through.
CREATE TABLE holdings (
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  as_of         TEXT NOT NULL,
  symbol        TEXT NOT NULL DEFAULT '',
  asset_class   TEXT,
  quantity      REAL,
  value_usd     REAL NOT NULL,
  cost_basis    REAL,
  PRIMARY KEY (account_id, as_of, symbol)
);

CREATE INDEX idx_hold_as_of ON holdings(as_of);

CREATE TABLE investment_txns (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  date          TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN
                  ('buy','sell','div','interest','fee','transfer','deposit','withdraw')),
  symbol        TEXT,
  quantity      REAL,
  price         REAL,
  amount        REAL NOT NULL,
  source_file   TEXT NOT NULL
);

CREATE INDEX idx_inv_date    ON investment_txns(date);
CREATE INDEX idx_inv_account ON investment_txns(account_id);
