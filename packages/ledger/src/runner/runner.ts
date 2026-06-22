import type { Database } from "bun:sqlite";
import { recordEvent } from "../gatekeepers/record_event";
import { postTransaction } from "../gatekeepers/post_transaction";
import { assertBalance } from "../gatekeepers/assert_balance";
import { oneSided } from "../gatekeepers/one_sided";
import type { ExternalRef, Operation } from "./operations";

const refKey = (r: ExternalRef): string => `${r.source} ${r.external_id}`;

/** True when refs are non-empty and none of them point at a raw_event
 *  freshly inserted in this run. Caller skips post in that case to
 *  preserve idempotency on re-syncs. */
function shouldSkipPost(
  refs: ExternalRef[] | undefined,
  freshRaws: Set<string>,
): boolean {
  if (!refs?.length) return false; // no refs → post unconditionally
  return refs.every((r) => !freshRaws.has(refKey(r)));
}

export interface RunSummary {
  raw_events: number;
  transactions: number;
  assertions: number;
  position_snapshots: number;
  asset_prices: number;
  accounts_discovered: number;
  warnings: number;
}

const emptySummary = (): RunSummary => ({
  raw_events: 0,
  transactions: 0,
  assertions: 0,
  position_snapshots: 0,
  asset_prices: 0,
  accounts_discovered: 0,
  warnings: 0,
});

/** Look up raw_event ids for a list of (source, external_id) refs.
 *  Skips refs that don't yet exist (the parser may emit a transaction
 *  whose linked raw_event was filtered out by an earlier idempotent
 *  insert). */
function resolveEventRefs(db: Database, refs: ExternalRef[] | undefined): number[] {
  if (!refs?.length) return [];
  const ids: number[] = [];
  const stmt = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM raw_events WHERE source = ? AND external_id = ?",
  );
  for (const ref of refs) {
    const row = stmt.get(ref.source, ref.external_id);
    if (row) ids.push(row.id);
  }
  return ids;
}

function upsertAccount(
  db: Database,
  draft: Extract<Operation, { kind: "account_discovery" }>["draft"],
): void {
  db.query(
    `INSERT INTO accounts (id, display_name, institution, type, currency, mode, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       institution = excluded.institution,
       type = excluded.type,
       mode = excluded.mode`,
  ).run(
    draft.id,
    draft.display_name,
    draft.institution,
    draft.type,
    draft.currency ?? "USD",
    draft.mode,
  );
}

function upsertPositionSnapshot(
  db: Database,
  draft: Extract<Operation, { kind: "position_snapshot" }>["draft"],
): void {
  const positionRow = db
    .query<{ id: number }, [string, string, string | null, string | null]>(
      `INSERT INTO positions (account_id, symbol, chain, contract_address)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, symbol, chain, contract_address) DO UPDATE SET
         account_id = excluded.account_id
       RETURNING id`,
    )
    .get(draft.account_id, draft.symbol, draft.chain ?? "", draft.contract_address ?? "");
  if (!positionRow) {
    throw new Error("failed to upsert position");
  }
  const value_usd =
    draft.price_usd != null ? draft.qty * draft.price_usd : 0;
  db.query(
    `INSERT INTO position_snapshots (position_id, as_of, quantity, value_usd, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(position_id, as_of, source) DO UPDATE SET
       quantity = excluded.quantity,
       value_usd = excluded.value_usd`,
  ).run(positionRow.id, draft.as_of, draft.qty, value_usd, draft.source);
}

function upsertAssetPrice(
  db: Database,
  draft: Extract<Operation, { kind: "asset_price" }>["draft"],
): void {
  db.query(
    `INSERT INTO asset_prices (chain, contract_address, symbol, as_of, source, price_usd)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain, contract_address, symbol, as_of, source) DO UPDATE SET
       price_usd = excluded.price_usd`,
  ).run(
    draft.chain,
    draft.contract_address,
    draft.symbol,
    draft.as_of,
    draft.source,
    draft.price_usd,
  );
}

function recordSyncWarning(
  db: Database,
  warning: Extract<Operation, { kind: "sync_warning" }>["warning"],
): void {
  const subject = warning.scope ?? "";
  const message =
    warning.detail !== undefined
      ? `${warning.message} | detail=${JSON.stringify(warning.detail)}`
      : warning.message;
  db.query(
    `INSERT INTO sync_warnings (source, kind, subject, message)
     VALUES (?, 'warning', ?, ?)`,
  ).run(warning.source, subject, message);

  if (
    warning.scope === "no_data" &&
    warning.detail &&
    typeof warning.detail === "object" &&
    "coinKey" in warning.detail
  ) {
    const coinKey = (warning.detail as { coinKey: string }).coinKey;
    db.query(
      `INSERT INTO price_source_misses (source, coin_key, last_checked)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(source, coin_key) DO UPDATE SET
         last_checked = excluded.last_checked`,
    ).run(warning.source, coinKey);
  }
}

/** Consume an async stream of operations and apply them through the
 *  gatekeepers. Returns counts per op kind. The runner is the only
 *  code path that reaches into the DB during a sync — parsers stay
 *  pure.
 *
 *  Idempotency contract: when a `transaction` or `one_sided` op
 *  carries `event_refs`, the post is skipped if every ref points at a
 *  raw_event that already existed before this run. This mirrors the
 *  Python ingest's record_event-then-post pattern and prevents
 *  duplicate transactions_v2 rows on re-sync. */
export async function runOperations(
  db: Database,
  ops: AsyncIterable<Operation>,
): Promise<RunSummary> {
  const summary = emptySummary();
  const freshRaws = new Set<string>(); // (source, external_id) inserted this run
  for await (const op of ops) {
    switch (op.kind) {
      case "raw_event": {
        const id = recordEvent(db, {
          source: op.source,
          external_id: op.external_id,
          payload: op.payload,
          source_file: op.source_file ?? null,
        });
        if (id != null) {
          summary.raw_events++;
          freshRaws.add(refKey({ source: op.source, external_id: op.external_id }));
        }
        break;
      }
      case "transaction": {
        if (shouldSkipPost(op.event_refs, freshRaws)) break;
        const raw_ids = resolveEventRefs(db, op.event_refs);
        postTransaction(db, { ...op.draft, raw_ids });
        summary.transactions++;
        break;
      }
      case "one_sided": {
        if (shouldSkipPost(op.event_refs, freshRaws)) break;
        const raw_ids = resolveEventRefs(db, op.event_refs);
        const ps = oneSided(op.draft.account_id, op.draft.amount, {
          payee: op.draft.payee,
          memo: op.draft.memo,
          currency: op.draft.currency,
        });
        postTransaction(db, {
          date: op.draft.date,
          description: op.draft.description,
          postings: [...ps],
          raw_ids,
          derived_by: op.draft.derived_by,
          category: op.draft.category,
          notes: op.draft.notes,
        });
        summary.transactions++;
        break;
      }
      case "assertion": {
        assertBalance(db, op.draft);
        summary.assertions++;
        break;
      }
      case "position_snapshot": {
        upsertPositionSnapshot(db, op.draft);
        summary.position_snapshots++;
        break;
      }
      case "asset_price": {
        upsertAssetPrice(db, op.draft);
        summary.asset_prices++;
        break;
      }
      case "account_discovery": {
        upsertAccount(db, op.draft);
        summary.accounts_discovered++;
        break;
      }
      case "sync_warning": {
        recordSyncWarning(db, op.warning);
        summary.warnings++;
        break;
      }
    }
  }
  return summary;
}
