-- Sync warnings. Persistent record of non-fatal issues from the last sync
-- of each source, so the dashboard can surface them instead of letting
-- silent CLI failures go unnoticed. Each sync run clears its own source's
-- rows first, so the table always reflects the latest run.
CREATE TABLE sync_warnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,       -- 'backfill:prices', 'backfill:crypto', etc.
  kind       TEXT NOT NULL,       -- 'symbol_not_found', 'fungible_not_found', etc.
  subject    TEXT NOT NULL,       -- ticker / fungible id / account id
  message    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sync_warnings_source ON sync_warnings(source);
