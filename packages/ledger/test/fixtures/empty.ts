import { Database } from "bun:sqlite";

/** Fresh in-memory DB with foreign_keys ON and nothing else. */
export function emptyDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
