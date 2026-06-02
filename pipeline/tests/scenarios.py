"""YAML scenario loader. Single source of truth for fixture data.

Loads a fixture file (or inline text) into a sqlite3 connection by:
  1. Validating the YAML against db/fixtures/_schema.json.
  2. For each table mentioned, looking up the live schema via
     PRAGMA table_info(<table>).
  3. Building dynamic INSERTs from each row's keys; reporting
     unknown-column and missing-required-column errors with file/row
     context.
  4. Running all architectural invariants unless validate=False.

Symmetric with dashboard/api/test/scenarios.ts. Drift between them
is caught by the cross-language meta-test (Phase 4)."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import datetime

import jsonschema
import yaml

import invariants


REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "db" / "fixtures" / "_schema.json"
FIXTURES_DIR = REPO_ROOT / "db" / "fixtures"


class FixtureError(RuntimeError):
    pass


@dataclass(frozen=True)
class Column:
    name: str
    notnull: bool
    has_default: bool


def _columns(conn: sqlite3.Connection, table: str) -> dict[str, Column]:
    cols: dict[str, Column] = {}
    for cid, name, ctype, notnull, dflt, pk in conn.execute(
        f"PRAGMA table_info({table})"
    ).fetchall():
        cols[name] = Column(name=name, notnull=bool(notnull), has_default=dflt is not None or bool(pk))
    return cols


def _insert_row(
    conn: sqlite3.Connection,
    table: str,
    row: dict[str, Any],
    cols: dict[str, Column],
    fixture_path: str,
    row_idx: int,
) -> int:
    unknown = [k for k in row if k not in cols]
    if unknown:
        raise FixtureError(
            f"fixture {fixture_path}: unknown column(s) {unknown!r} in table {table!r} "
            f"(row #{row_idx}). Known columns: {sorted(cols)}"
        )
    missing = [
        c.name
        for c in cols.values()
        if c.notnull and not c.has_default and c.name not in row
    ]
    if missing:
        raise FixtureError(
            f"fixture {fixture_path}: required column(s) {missing!r} missing for "
            f"table {table!r} (row #{row_idx}). Provided: {sorted(row)}"
        )
    keys = list(row.keys())
    placeholders = ",".join("?" for _ in keys)
    cur = conn.execute(
        f"INSERT INTO {table} ({','.join(keys)}) VALUES ({placeholders})",
        [row[k] for k in keys],
    )
    return int(cur.lastrowid or 0)


def _load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def _normalize_dates(obj: Any) -> Any:
    """Recursively convert datetime.date / datetime.datetime to ISO strings.

    PyYAML parses bare YYYY-MM-DD values as datetime.date objects. SQLite
    expects TEXT for date columns and jsonschema expects type:string for as_of.
    """
    if isinstance(obj, datetime.datetime):
        return obj.isoformat()
    if isinstance(obj, datetime.date):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _normalize_dates(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_dates(v) for v in obj]
    return obj


def load_scenario_text(
    conn: sqlite3.Connection,
    text: str,
    *,
    fixture_path: str,
    validate: bool = True,
) -> dict:
    """Load a scenario from in-memory YAML text. Returns the parsed dict
    (so tests can read scenario['as_of'] for windowing). Raises
    FixtureError on shape mismatch; AssertionError on invariant failure."""
    doc = yaml.safe_load(text)
    if not isinstance(doc, dict):
        raise FixtureError(f"fixture {fixture_path}: top-level must be a mapping")
    doc = _normalize_dates(doc)

    schema = _load_schema()
    try:
        jsonschema.Draft202012Validator(schema).validate(doc)
    except jsonschema.ValidationError as e:
        raise FixtureError(
            f"fixture {fixture_path}: schema violation at {list(e.absolute_path)}: {e.message}"
        ) from e

    # Insert order matters for FK satisfaction.
    if "data_sources" in doc:
        cols = _columns(conn, "data_sources")
        for i, row in enumerate(doc["data_sources"]):
            _insert_row(conn, "data_sources", row, cols, fixture_path, i)

    if "accounts" in doc:
        cols = _columns(conn, "accounts")
        # Two passes so merged_into can reference rows in the same fixture.
        deferred = []
        for i, row in enumerate(doc["accounts"]):
            r = dict(row)
            if r.get("merged_into") is not None:
                deferred.append((i, r))
                r = {k: v for k, v in r.items() if k != "merged_into"}
            _insert_row(conn, "accounts", r, cols, fixture_path, i)
        for i, r in deferred:
            conn.execute(
                "UPDATE accounts SET merged_into = ? WHERE id = ?",
                (r["merged_into"], r["id"]),
            )

    if "raw_events" in doc:
        cols = _columns(conn, "raw_events")
        for i, row in enumerate(doc["raw_events"]):
            r = dict(row)
            if isinstance(r.get("payload"), (dict, list)):
                r["payload"] = json.dumps(r["payload"])
            _insert_row(conn, "raw_events", r, cols, fixture_path, i)

    if "postings" in doc:
        txn_cols = _columns(conn, "transactions_v2")
        post_cols = _columns(conn, "postings")
        item_cols = _columns(conn, "transaction_items")
        for i, p in enumerate(doc["postings"]):
            txn_id = _insert_row(conn, "transactions_v2", dict(p["txn"]), txn_cols, fixture_path, i)
            for j, leg in enumerate(p["legs"]):
                row = dict(leg)
                row["txn_id"] = txn_id
                _insert_row(conn, "postings", row, post_cols, fixture_path, f"{i}/{j}")
            for k, item in enumerate(p.get("items") or []):
                row = dict(item)
                row["transaction_v2_id"] = txn_id
                _insert_row(conn, "transaction_items", row, item_cols, fixture_path, f"{i}/item{k}")

    if "balance_assertions" in doc:
        cols = _columns(conn, "balance_assertions")
        for i, row in enumerate(doc["balance_assertions"]):
            _insert_row(conn, "balance_assertions", row, cols, fixture_path, i)

    if "positions" in doc:
        cols = _columns(conn, "positions")
        for i, row in enumerate(doc["positions"]):
            _insert_row(conn, "positions", row, cols, fixture_path, i)

    if "position_snapshots" in doc:
        cols = _columns(conn, "position_snapshots")
        for i, row in enumerate(doc["position_snapshots"]):
            _insert_row(conn, "position_snapshots", row, cols, fixture_path, i)

    if "asset_prices" in doc:
        cols = _columns(conn, "asset_prices")
        for i, row in enumerate(doc["asset_prices"]):
            _insert_row(conn, "asset_prices", row, cols, fixture_path, i)

    conn.commit()

    if validate:
        invariants.run_all(conn)
    return doc


def load_scenario(
    conn: sqlite3.Connection,
    fixture: str | Path,
    *,
    validate: bool = True,
) -> dict:
    """Load a scenario by name (e.g. 'simple_household') or path."""
    if isinstance(fixture, str) and "/" not in fixture and not fixture.endswith(".yaml"):
        path = FIXTURES_DIR / f"{fixture}.yaml"
    else:
        path = Path(fixture)
    return load_scenario_text(
        conn, path.read_text(), fixture_path=str(path), validate=validate
    )
