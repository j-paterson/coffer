-- Tracks the last time we successfully fetched from a slow/rate-limited
-- upstream (Zerion /charts, Yahoo /chart, etc). Lets sync + backfill skip
-- redundant calls when we already pulled the same subject recently.
CREATE TABLE provider_cache (
  source     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, subject)
);
