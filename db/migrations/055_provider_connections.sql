-- db/migrations/055_provider_connections.sql
--
-- In-app provider connections: store secrets and per-provider non-secret
-- config in the DB so providers can be connected without editing
-- finance.config.ts / .env. Secrets are keyed by the env-var name the
-- parsers already reference (e.g. SIMPLEFIN_ACCESS_URL).

CREATE TABLE IF NOT EXISTS provider_secrets (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_connections (
  parser_id         TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 1,
  config_json       TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'disconnected',
  last_connected_at TEXT
);
