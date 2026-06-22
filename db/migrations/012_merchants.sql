-- 012_merchants.sql
-- Merchant-level category cache. For non-Amazon receipts, knowing what a
-- retailer sells (from their own homepage) lets us skip per-item
-- classification entirely — all items from a clothing retailer are clothing.
--
-- Populated by `finance classify-merchants`, which fetches the homepage of
-- each distinct sender domain, parses the title/description, and asks a
-- local LLM to classify it. One HTTP GET per domain, cached forever.

CREATE TABLE merchants (
  domain          TEXT PRIMARY KEY,
  display_name    TEXT,
  category        TEXT,
  sells_description TEXT,
  source          TEXT NOT NULL,  -- 'homepage' | 'llm_only' | 'manual'
  confidence      REAL,
  fetched_at      TEXT,
  notes           TEXT
);

CREATE INDEX idx_merchants_category ON merchants(category);
