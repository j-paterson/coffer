-- data_sources: single source-of-truth for "what data sources exist,
-- what's their trust rank, are they currently enabled."
--
-- Walker, pad, validator, summary, portfolio, etc. all read from this
-- table instead of carrying hard-coded CASE statements. Toggle a
-- source off (UPDATE enabled=0) to instantly see the system without
-- it — no code change. Bump a rank to re-prioritize without redeploys.
--
-- `kind` distinguishes:
--   'assertion' — sources that write balance_assertions (driven by pad)
--   'snapshot'  — sources that write position_snapshots (driven by query-time priority)
--
-- A source can be both (e.g., kubera writes assertions AND snapshots).
-- Use ('source','kind') composite.

CREATE TABLE data_sources (
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assertion', 'snapshot')),
  trust_rank INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  PRIMARY KEY (name, kind)
);

CREATE INDEX idx_data_sources_enabled ON data_sources(kind, enabled);

-- Seed with current trust order. Lower rank = higher trust.
-- Assertion sources (drive pad and balance_assertions reads):
INSERT INTO data_sources (name, kind, trust_rank, enabled, notes) VALUES
  ('manual',           'assertion', 0, 1, 'User-entered ground truth'),
  ('chase-statement',  'assertion', 1, 1, 'Signed monthly statement PDF'),
  ('masterworks-k1',   'assertion', 2, 1, 'Tax K-1 ending capital'),
  ('simplefin',        'assertion', 3, 1, 'Live institution feed'),
  ('zerion',           'assertion', 4, 1, 'Live on-chain wallet sync'),
  ('alchemy',          'assertion', 5, 1, 'On-chain query (Zerion fallback)'),
  ('kubera',           'assertion', 6, 1, 'Live Kubera Financial.json snapshot'),
  ('kubera-recap',     'assertion', 7, 1, 'Quarterly recap CSV (often underreports)'),
  ('zerion-chart',     'assertion', 8, 1, 'Historical wallet TOTAL chart'),
  ('backfill:yfinance','assertion', 9, 1, 'Synthesized from market prices');

-- Snapshot sources (drive position_snapshots reads):
INSERT INTO data_sources (name, kind, trust_rank, enabled, notes) VALUES
  ('simplefin',                'snapshot', 0, 1, 'Institution direct feed'),
  ('zerion',                   'snapshot', 1, 1, 'Live on-chain'),
  ('alchemy',                  'snapshot', 2, 1, 'On-chain fallback'),
  ('kubera',                   'snapshot', 3, 1, 'Aggregator snapshot'),
  ('zerion-chart',             'snapshot', 4, 1, 'Historical wallet chart'),
  ('backfill:txn-walk',        'snapshot', 5, 1, 'CoinTracker qty × DefiLlama price'),
  ('backfill:zerion-fungible', 'snapshot', 6, 1, 'Current qty × Zerion fungible chart'),
  ('backfill:yfinance',        'snapshot', 7, 1, 'Equity prices via yfinance');
