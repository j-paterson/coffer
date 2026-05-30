import { Database } from "bun:sqlite";
import type { ParserCache } from "../types/cache";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS parser_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS parser_cache_expires_idx
    ON parser_cache (expires_at);
`;

export class SqliteParserCache implements ParserCache {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.db = new Database(path);
    this.db.exec(SCHEMA_SQL);
    this.now = now;
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.db
      .query("SELECT value, expires_at FROM parser_cache WHERE key = ?")
      .get(key) as { value: string; expires_at: number | null } | null;
    if (!row) return null;
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (row.expires_at !== null && row.expires_at <= nowSec) {
      this.db.query("DELETE FROM parser_cache WHERE key = ?").run(key);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds === undefined
      ? null
      : Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    this.db
      .query(
        "INSERT OR REPLACE INTO parser_cache (key, value, expires_at) VALUES (?, ?, ?)",
      )
      .run(key, JSON.stringify(value), expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.db.query("DELETE FROM parser_cache WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();
  }
}
