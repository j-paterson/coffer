import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, parse } from "node:path";

const SCHEMA_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

/** Set of versions already applied. Creates the tracking table if absent. */
export function appliedVersions(db: Database): Set<string> {
  db.exec(SCHEMA_TABLE_SQL);
  const rows = db
    .query<{ version: string }, []>("SELECT version FROM schema_migrations")
    .all();
  return new Set(rows.map((r) => r.version));
}

/** Apply every *.sql file in `migrationsDir` whose stem isn't yet recorded
 *  in `schema_migrations`. Lex order. Returns the list of versions newly
 *  applied. Idempotent. */
export function applyMigrations(
  db: Database,
  migrationsDir: string,
): string[] {
  const applied = appliedVersions(db);
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const newlyApplied: string[] = [];
  for (const f of files) {
    const version = parse(f).name;
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query(
        "INSERT INTO schema_migrations (version) VALUES (?)",
      ).run(version);
    })();
    newlyApplied.push(version);
  }
  return newlyApplied;
}
