import type { Database } from "bun:sqlite";

export interface NoteReconciliationInput {
  account_id: string;
  as_of: string;
  kind: string;
  detail: unknown;
}

/** Append-only audit row. Used by matchers and reconciliation deltas
 *  to leave a trail without mutating raw_events. */
export function noteReconciliation(
  db: Database,
  input: NoteReconciliationInput,
): void {
  db.query(
    `INSERT INTO reconciliation_notes (account_id, as_of, kind, detail)
     VALUES (?, ?, ?, ?)`,
  ).run(
    input.account_id,
    input.as_of,
    input.kind,
    JSON.stringify(input.detail),
  );
}
