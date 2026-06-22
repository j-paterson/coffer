"""Meta-test: every fixture in db/fixtures/ loads cleanly, satisfies
every invariant, and is byte-stable across reloads (idempotency check
against silent default drift)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from scenarios import FIXTURES_DIR, load_scenario


def _fixture_files() -> list[Path]:
    return sorted(p for p in FIXTURES_DIR.glob("*.yaml") if not p.name.startswith("_"))


@pytest.mark.parametrize("fx", _fixture_files(), ids=lambda p: p.stem)
def test_fixture_loads_and_validates(conn: sqlite3.Connection, fx: Path):
    """Every fixture must load with validate=True (i.e. pass invariants)."""
    load_scenario(conn, fx, validate=True)


@pytest.mark.parametrize("fx", _fixture_files(), ids=lambda p: p.stem)
def test_fixture_is_idempotent(fx: Path, request: pytest.FixtureRequest):
    """Loading the same fixture twice into two fresh DBs must produce
    identical row dumps — guards against default-value drift."""
    from conftest import _load_schema  # type: ignore

    def dump(conn: sqlite3.Connection) -> str:
        out: list[str] = []
        tables = [
            "accounts", "data_sources", "raw_events",
            "transactions_v2", "postings", "balance_assertions",
            "positions", "position_snapshots", "asset_prices",
        ]
        for t in tables:
            rows = conn.execute(
                f"SELECT * FROM {t} ORDER BY rowid"
            ).fetchall()
            out.append(f"--- {t} ({len(rows)}) ---")
            for r in rows:
                out.append(repr(tuple(r)))
        return "\n".join(out)

    def fresh() -> sqlite3.Connection:
        c = sqlite3.connect(":memory:")
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        _load_schema(c)
        load_scenario(c, fx)
        return c

    a, b = fresh(), fresh()
    assert dump(a) == dump(b)
