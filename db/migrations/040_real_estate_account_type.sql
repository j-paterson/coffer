-- Add 'real_estate' to the accounts.type CHECK set and retype the
-- property account. Previously real estate sat under 'alt' alongside
-- Vintage Art Fund and other alternatives, which made it impossible to
-- target the home account cleanly (the HELOC projection sandbox needs
-- to locate exactly one account: the primary residence).
--
-- Same recreate-table trick as migration 033, since SQLite CHECK
-- constraints are baked into the table definition.

PRAGMA foreign_keys = OFF;

CREATE TABLE accounts_new (
  id                    TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  institution           TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN
                          ('credit','checking','savings','brokerage',
                           'retirement','crypto','alt','manual','equity',
                           'real_estate')),
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
SET type = 'real_estate'
WHERE id = 'manual:property:los-ranchos-8401';

PRAGMA foreign_keys = ON;
