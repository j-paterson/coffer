import type { Database } from "bun:sqlite";

export interface AssertBalanceInput {
  account_id: string;
  as_of: string;
  expected_usd: number;
  source: string;
  source_file?: string | null;
}

/** Idempotent upsert of a ground-truth balance snapshot. */
export function assertBalance(db: Database, input: AssertBalanceInput): void {
  db.query(
    `INSERT INTO balance_assertions (account_id, as_of, expected_usd, source, source_file)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, as_of, source) DO UPDATE SET
       expected_usd = excluded.expected_usd,
       source_file  = excluded.source_file`,
  ).run(
    input.account_id,
    input.as_of,
    input.expected_usd,
    input.source,
    input.source_file ?? null,
  );
}
