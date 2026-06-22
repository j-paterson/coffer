-- 006_emails_and_transaction_items.sql
-- Email receipt enrichment (milestone 8b).
--
-- `emails` caches each receipt email we've ingested, along with the
-- fields extracted by NuExtract and the match state against the
-- transactions table. One row per Gmail message ID.
--
-- `transaction_items` stores the per-line items pulled out of an email.
-- Each item is tied to its source email, and once the email is matched
-- to a transaction, items inherit the transaction_id so the dashboard
-- can drill from a transaction straight to its line items.

CREATE TABLE emails (
  id                 TEXT PRIMARY KEY,        -- gmail message id
  received_at        TEXT NOT NULL,           -- iso8601 from Date header
  from_addr          TEXT NOT NULL,
  subject            TEXT NOT NULL,
  raw_path           TEXT NOT NULL,           -- raw/email/YYYY-MM-DD/<id>.eml

  -- Fields extracted by NuExtract. Nullable because extraction can fail
  -- or leave fields blank (valid for Stripe-style receipts without items).
  merchant           TEXT,
  receipt_date       TEXT,                    -- iso date (post-normalized)
  total_usd          REAL,
  currency           TEXT,
  order_id           TEXT,
  payment_hint       TEXT,                    -- e.g. "Visa 7800", raw extraction

  extraction_status  TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN
                       ('pending','extracted','failed','skipped')),
  extraction_model   TEXT,                    -- e.g. 'nuextract:3.8b'
  extracted_at       TEXT,
  raw_extraction     TEXT,                    -- full NuExtract json blob, for replay

  match_status       TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN
                       ('unmatched','strict','fuzzy','uncertain','none')),
  transaction_id     TEXT REFERENCES transactions(id),

  imported_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_emails_received  ON emails(received_at);
CREATE INDEX idx_emails_merchant  ON emails(merchant);
CREATE INDEX idx_emails_txn       ON emails(transaction_id);
CREATE INDEX idx_emails_match     ON emails(match_status);

CREATE TABLE transaction_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id        TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  transaction_id  TEXT REFERENCES transactions(id),  -- set when email is matched
  line_no         INTEGER NOT NULL,                   -- 1-based order within the receipt
  name            TEXT NOT NULL,
  quantity        REAL,
  unit_price      REAL,
  line_total      REAL,
  raw             TEXT                                -- untouched extraction, pre-cleanup
);

CREATE INDEX idx_items_email ON transaction_items(email_id);
CREATE INDEX idx_items_txn   ON transaction_items(transaction_id);
