import type { Database } from "bun:sqlite";

export interface RecordEventInput {
  source: string;
  external_id: string;
  payload: unknown;
  source_file?: string | null;
}

/** Append a raw event. Idempotent on (source, external_id). Returns the
 *  inserted id, or null if the row already existed. */
export function recordEvent(db: Database, input: RecordEventInput): number | null {
  const result = db
    .query(
      `INSERT OR IGNORE INTO raw_events (source, source_file, external_id, payload)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.source,
      input.source_file ?? null,
      input.external_id,
      JSON.stringify(input.payload),
    );
  if (result.changes === 0) return null;
  return Number(result.lastInsertRowid);
}
