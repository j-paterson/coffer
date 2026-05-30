-- Retype the three equity placeholder accounts from 'alt' to 'equity'.
-- They were originally created as 'alt' in migration 021 but share that
-- type with real alternative investments (Masterworks, real estate).
-- Queries filtering on type='alt' inadvertently pull in every transaction
-- in the database via equity:unknown-counterparty.
--
-- SQLite CHECK constraints are baked into the table definition and can't
-- be altered, so we recreate the table with the expanded type set.

PRAGMA foreign_keys = OFF;

CREATE TABLE accounts_new (
  id                    TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  institution           TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN
                          ('credit','checking','savings','brokerage',
                           'retirement','crypto','alt','manual','equity')),
  currency              TEXT NOT NULL DEFAULT 'USD',
  active                INTEGER NOT NULL DEFAULT 1,
  mode                  TEXT NOT NULL DEFAULT 'manual'
                          CHECK (mode IN ('manual','live')),
  merged_into           TEXT REFERENCES accounts_new(id),
  display_name_override TEXT
);

INSERT INTO accounts_new
SELECT id, display_name, institution, type, currency, active, mode,
       merged_into, display_name_override
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

UPDATE accounts
SET type = 'equity'
WHERE id LIKE 'equity:%';

PRAGMA foreign_keys = ON;
