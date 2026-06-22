import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { emptyDb } from "./fixtures/empty";
import { applyMigrations } from "../src/schema/migrate";
import { runOperations } from "../src/runner/runner";
import { posting } from "../src/gatekeepers/posting";
import type { Operation } from "../src/runner/operations";
import { resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dir, "../../../db/migrations");

async function* gen(...ops: Operation[]): AsyncIterable<Operation> {
  for (const op of ops) yield op;
}

describe("runOperations", () => {
  let db: Database;
  beforeEach(() => {
    db = emptyDb();
    applyMigrations(db, MIGRATIONS);
    for (const id of ["acct:a", "acct:b", "equity:unknown-counterparty"]) {
      db.query(
        `INSERT OR IGNORE INTO accounts (id, display_name, institution, type, mode, active) VALUES (?, ?, 'test', 'checking', 'manual', 1)`,
      ).run(id, id);
    }
  });

  test("records raw_events and counts them in summary", async () => {
    const summary = await runOperations(
      db,
      gen(
        { kind: "raw_event", source: "s", external_id: "x1", payload: {} },
        { kind: "raw_event", source: "s", external_id: "x2", payload: {} },
      ),
    );
    expect(summary.raw_events).toBe(2);
    const n = db.query("SELECT COUNT(*) AS n FROM raw_events").get() as { n: number };
    expect(n.n).toBe(2);
  });

  test("transaction op posts a balanced txn and links event_refs", async () => {
    const summary = await runOperations(
      db,
      gen(
        { kind: "raw_event", source: "s", external_id: "x1", payload: {} },
        {
          kind: "transaction",
          draft: {
            date: "2025-01-15",
            description: "Linked",
            postings: [posting("acct:a", -5), posting("acct:b", 5)],
          },
          event_refs: [{ source: "s", external_id: "x1" }],
        },
      ),
    );
    expect(summary.transactions).toBe(1);
    const links = db.query("SELECT COUNT(*) AS n FROM event_links").get() as { n: number };
    expect(links.n).toBe(1);
  });

  test("one_sided op expands to a balanced txn with equity counterparty", async () => {
    await runOperations(
      db,
      gen({
        kind: "one_sided",
        draft: {
          date: "2025-01-15",
          description: "Comcast",
          account_id: "acct:a",
          amount: -42.5,
        },
      }),
    );
    const ps = db.query(
      `SELECT account_id, amount FROM postings ORDER BY account_id`,
    ).all() as Array<{ account_id: string; amount: number }>;
    expect(ps).toEqual([
      { account_id: "acct:a", amount: -42.5 },
      { account_id: "equity:unknown-counterparty", amount: 42.5 },
    ]);
  });

  test("assertion op upserts balance_assertions", async () => {
    await runOperations(
      db,
      gen({
        kind: "assertion",
        draft: { account_id: "acct:a", as_of: "2025-01-15", expected_usd: 100, source: "x" },
      }),
    );
    const row = db.query("SELECT expected_usd FROM balance_assertions WHERE account_id = ?")
      .get("acct:a") as { expected_usd: number };
    expect(row.expected_usd).toBe(100);
  });

  test("account_discovery op upserts an accounts row", async () => {
    await runOperations(
      db,
      gen({
        kind: "account_discovery",
        draft: { id: "acct:new", display_name: "New", institution: "test", type: "checking", mode: "live" },
      }),
    );
    const row = db.query("SELECT display_name, mode FROM accounts WHERE id = ?")
      .get("acct:new") as { display_name: string; mode: string };
    expect(row).toEqual({ display_name: "New", mode: "live" });
  });

  test("sync_warning op records to sync_warnings (does not throw)", async () => {
    await runOperations(
      db,
      gen({
        kind: "sync_warning",
        warning: { source: "simplefin", scope: "acct:a", message: "stale token" },
      }),
    );
    const n = db.query("SELECT COUNT(*) AS n FROM sync_warnings").get() as { n: number };
    expect(n.n).toBeGreaterThanOrEqual(1);
  });

  test("aggregates counts per kind into the summary", async () => {
    const summary = await runOperations(
      db,
      gen(
        { kind: "raw_event", source: "s", external_id: "x1", payload: {} },
        {
          kind: "transaction",
          draft: {
            date: "2025-01-15",
            description: "T",
            postings: [posting("acct:a", -1), posting("acct:b", 1)],
          },
        },
        {
          kind: "assertion",
          draft: { account_id: "acct:a", as_of: "2025-01-15", expected_usd: 0, source: "s" },
        },
      ),
    );
    expect(summary).toMatchObject({
      raw_events: 1,
      transactions: 1,
      assertions: 1,
    });
  });

  test("re-running the same op stream does not duplicate transactions", async () => {
    const ops: Operation[] = [
      { kind: "raw_event", source: "s", external_id: "x1", payload: {} },
      {
        kind: "transaction",
        draft: {
          date: "2025-01-15",
          description: "Linked",
          postings: [posting("acct:a", -5), posting("acct:b", 5)],
        },
        event_refs: [{ source: "s", external_id: "x1" }],
      },
    ];

    const first = await runOperations(db, gen(...ops));
    expect(first.raw_events).toBe(1);
    expect(first.transactions).toBe(1);

    const txnsBefore = (db.query("SELECT COUNT(*) AS n FROM transactions_v2").get() as { n: number }).n;

    const second = await runOperations(db, gen(...ops));
    expect(second.raw_events).toBe(0);
    expect(second.transactions).toBe(0);

    const txnsAfter = (db.query("SELECT COUNT(*) AS n FROM transactions_v2").get() as { n: number }).n;
    expect(txnsAfter).toBe(txnsBefore);
  });

  test("transaction without event_refs always posts (unchanged behavior)", async () => {
    const op: Operation = {
      kind: "transaction",
      draft: {
        date: "2025-01-15",
        description: "Manual",
        postings: [posting("acct:a", -1), posting("acct:b", 1)],
      },
    };
    const first = await runOperations(db, gen(op));
    const second = await runOperations(db, gen(op));
    expect(first.transactions).toBe(1);
    expect(second.transactions).toBe(1); // posts both times — no event_refs → no idempotency claim
    const n = (db.query("SELECT COUNT(*) AS n FROM transactions_v2").get() as { n: number }).n;
    expect(n).toBe(2);
  });

  test("one_sided op is gated by event_refs the same way transaction is", async () => {
    const ops: Operation[] = [
      { kind: "raw_event", source: "s", external_id: "y1", payload: {} },
      {
        kind: "one_sided",
        draft: {
          date: "2025-01-15",
          description: "Comcast",
          account_id: "acct:a",
          amount: -42.5,
        },
        event_refs: [{ source: "s", external_id: "y1" }],
      },
    ];
    const first = await runOperations(db, gen(...ops));
    expect(first.transactions).toBe(1);
    const second = await runOperations(db, gen(...ops));
    expect(second.transactions).toBe(0);
  });
});
