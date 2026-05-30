CREATE TABLE IF NOT EXISTS price_source_misses (
  source       TEXT NOT NULL,
  coin_key     TEXT NOT NULL,
  last_checked TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (source, coin_key)
);
