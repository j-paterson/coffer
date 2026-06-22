/** TS mirror of pipeline/tests/scenarios.py.
 *
 *  Loads a YAML fixture (or inline text) into a Database via PRAGMA-driven
 *  dynamic INSERTs, then runs all architectural invariants unless
 *  validate=false.
 *
 *  Single source of truth for fixture data is db/fixtures/*.yaml; both
 *  the Python loader and this loader load the same files. Drift is
 *  caught by the cross-language meta-test (Phase 4). */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runAll } from "./invariants";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const FIXTURES_DIR = resolve(REPO_ROOT, "db/fixtures");

export class FixtureError extends Error {
  constructor(msg: string) { super(msg); this.name = "FixtureError"; }
}

interface Column {
  name: string;
  notnull: boolean;
  hasDefault: boolean;
}

function columnsOf(db: Database, table: string): Map<string, Column> {
  const out = new Map<string, Column>();
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    cid: number; name: string; type: string; notnull: number;
    dflt_value: unknown; pk: number;
  }>;
  for (const r of rows) {
    out.set(r.name, {
      name: r.name,
      notnull: !!r.notnull,
      hasDefault: r.dflt_value !== null || !!r.pk,
    });
  }
  return out;
}

function insertRow(
  db: Database,
  table: string,
  row: Record<string, unknown>,
  cols: Map<string, Column>,
  fixturePath: string,
  rowIdx: string | number,
): number | bigint {
  const unknown = Object.keys(row).filter((k) => !cols.has(k));
  if (unknown.length) {
    throw new FixtureError(
      `fixture ${fixturePath}: unknown column(s) ${JSON.stringify(unknown)} in table ${JSON.stringify(table)} ` +
      `(row #${rowIdx}). Known columns: ${JSON.stringify([...cols.keys()].sort())}`
    );
  }
  const missing: string[] = [];
  for (const c of cols.values()) {
    if (c.notnull && !c.hasDefault && !(c.name in row)) missing.push(c.name);
  }
  if (missing.length) {
    throw new FixtureError(
      `fixture ${fixturePath}: required column(s) ${JSON.stringify(missing)} missing for ` +
      `table ${JSON.stringify(table)} (row #${rowIdx}). Provided: ${JSON.stringify(Object.keys(row).sort())}`
    );
  }
  const keys = Object.keys(row);
  const placeholders = keys.map(() => "?").join(",");
  const stmt = db.prepare(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders})`,
  );
  return stmt.run(...keys.map((k) => row[k] as never)).lastInsertRowid;
}

export function loadScenarioText(
  db: Database,
  text: string,
  fixturePath: string,
  options: { validate?: boolean } = {},
): Record<string, unknown> {
  const validate = options.validate ?? true;
  const doc = parseYaml(text) as Record<string, unknown>;
  if (!doc || typeof doc !== "object") {
    throw new FixtureError(`fixture ${fixturePath}: top-level must be a mapping`);
  }

  // Note: schema validation (jsonschema) intentionally omitted here —
  // the Python loader performs it, and the cross-language meta-test
  // (Phase 4) will surface any TS/Python drift if a YAML passes Python
  // but fails here. Adding ajv on the TS side is a Phase 4 task.

  if (Array.isArray(doc.data_sources)) {
    const cols = columnsOf(db, "data_sources");
    (doc.data_sources as Array<Record<string, unknown>>).forEach((row, i) => {
      insertRow(db, "data_sources", row, cols, fixturePath, i);
    });
  }

  if (Array.isArray(doc.accounts)) {
    const cols = columnsOf(db, "accounts");
    const deferred: Array<{ id: string; mergedInto: string }> = [];
    (doc.accounts as Array<Record<string, unknown>>).forEach((row, i) => {
      const r: Record<string, unknown> = { ...row };
      if (r.merged_into != null) {
        deferred.push({ id: r.id as string, mergedInto: r.merged_into as string });
        delete r.merged_into;
      }
      insertRow(db, "accounts", r, cols, fixturePath, i);
    });
    for (const d of deferred) {
      db.run("UPDATE accounts SET merged_into = ? WHERE id = ?", [d.mergedInto, d.id]);
    }
  }

  if (Array.isArray(doc.raw_events)) {
    const cols = columnsOf(db, "raw_events");
    (doc.raw_events as Array<Record<string, unknown>>).forEach((row, i) => {
      const r = { ...row };
      if (r.payload && typeof r.payload === "object") r.payload = JSON.stringify(r.payload);
      insertRow(db, "raw_events", r, cols, fixturePath, i);
    });
  }

  if (Array.isArray(doc.postings)) {
    const txnCols = columnsOf(db, "transactions_v2");
    const postCols = columnsOf(db, "postings");
    const itemCols = columnsOf(db, "transaction_items");
    (doc.postings as Array<{ txn: Record<string, unknown>; legs: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> }>)
      .forEach((p, i) => {
        const txnId = insertRow(db, "transactions_v2", p.txn, txnCols, fixturePath, i);
        const txnIdNum = typeof txnId === "bigint" ? Number(txnId) : txnId;
        p.legs.forEach((leg, j) => {
          insertRow(
            db, "postings",
            { ...leg, txn_id: txnIdNum },
            postCols, fixturePath, `${i}/${j}`,
          );
        });
        if (Array.isArray(p.items)) {
          p.items.forEach((item, k) => {
            insertRow(
              db, "transaction_items",
              { ...item, transaction_v2_id: txnIdNum },
              itemCols, fixturePath, `${i}/item${k}`,
            );
          });
        }
      });
  }

  for (const tbl of ["balance_assertions", "positions", "position_snapshots", "asset_prices"] as const) {
    if (Array.isArray(doc[tbl])) {
      const cols = columnsOf(db, tbl);
      (doc[tbl] as Array<Record<string, unknown>>).forEach((row, i) => {
        insertRow(db, tbl, row, cols, fixturePath, i);
      });
    }
  }

  if (validate) runAll(db);
  return doc;
}

export function loadScenario(
  db: Database,
  fixture: string,
  options: { validate?: boolean } = {},
): Record<string, unknown> {
  const path = isAbsolute(fixture) || fixture.includes("/") || fixture.endsWith(".yaml")
    ? fixture
    : resolve(FIXTURES_DIR, `${fixture}.yaml`);
  const text = readFileSync(path, "utf8");
  return loadScenarioText(db, text, path, options);
}
