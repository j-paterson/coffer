"""Tests for the scenario YAML loader.

The loader's contract: PRAGMA-driven dynamic INSERTs (so unknown
columns and missing-required columns surface as helpful errors), then
run all invariants unless validate=False."""

from __future__ import annotations

import sqlite3
import textwrap
from pathlib import Path

import pytest

from scenarios import (
    FixtureError,
    load_scenario,
    load_scenario_text,
)


def test_load_minimal_scenario(conn: sqlite3.Connection):
    text = textwrap.dedent("""
        name: minimal
        description: just one account
        as_of: 2026-04-27
        accounts:
          - id: a
            type: checking
            institution: Test
            display_name: A
            mode: live
            active: 1
    """)
    load_scenario_text(conn, text, fixture_path="(inline)")
    # Exclude equity:* accounts pre-seeded by migrations; compare as tuples.
    rows = [
        tuple(r)
        for r in conn.execute(
            "SELECT id, type FROM accounts WHERE id NOT LIKE 'equity:%'"
        ).fetchall()
    ]
    assert rows == [("a", "checking")]


def test_unknown_column_errors(conn: sqlite3.Connection):
    text = textwrap.dedent("""
        name: bad
        description: unknown column
        as_of: 2026-04-27
        accounts:
          - id: a
            type: checking
            institution: Test
            display_name: A
            not_a_column: oops
    """)
    with pytest.raises(FixtureError) as ei:
        load_scenario_text(conn, text, fixture_path="(inline)")
    assert "unknown column" in str(ei.value).lower()
    assert "not_a_column" in str(ei.value)
    assert "accounts" in str(ei.value)


def test_missing_required_column_errors(conn: sqlite3.Connection):
    # accounts.institution is NOT NULL with no default — omit it.
    text = textwrap.dedent("""
        name: bad
        description: missing required
        as_of: 2026-04-27
        accounts:
          - id: a
            type: checking
            display_name: A
    """)
    with pytest.raises(FixtureError) as ei:
        load_scenario_text(conn, text, fixture_path="(inline)")
    assert "required column" in str(ei.value).lower()
    assert "institution" in str(ei.value)


def test_postings_resolve_to_balanced_transaction(conn: sqlite3.Connection):
    text = textwrap.dedent("""
        name: bal
        description: balanced txn
        as_of: 2026-04-27
        accounts:
          - { id: a, type: checking, institution: Test, display_name: A }
          - { id: b, type: checking, institution: Test, display_name: B }
        postings:
          - txn:
              date: 2025-06-01
              description: transfer
              derived_by: ingest
            legs:
              - { account_id: a, amount: 100.00 }
              - { account_id: b, amount: -100.00 }
    """)
    load_scenario_text(conn, text, fixture_path="(inline)")
    n_txn = conn.execute("SELECT COUNT(*) FROM transactions_v2").fetchone()[0]
    n_post = conn.execute("SELECT COUNT(*) FROM postings").fetchone()[0]
    assert (n_txn, n_post) == (1, 2)


def test_validate_false_skips_invariants(conn: sqlite3.Connection):
    """An unbalanced posting set must be loadable with validate=False."""
    text = textwrap.dedent("""
        name: unbal
        description: deliberately unbalanced for negative tests
        as_of: 2026-04-27
        accounts:
          - { id: a, type: checking, institution: Test, display_name: A }
          - { id: b, type: checking, institution: Test, display_name: B }
        postings:
          - txn:
              date: 2025-06-01
              description: bad
              derived_by: ingest
            legs:
              - { account_id: a, amount: 100.00 }
              - { account_id: b, amount: -50.00 }
    """)
    load_scenario_text(conn, text, fixture_path="(inline)", validate=False)
    # Must load successfully.
    assert conn.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 2


def test_validate_true_runs_invariants(conn: sqlite3.Connection):
    text = textwrap.dedent("""
        name: unbal
        description: deliberately unbalanced
        as_of: 2026-04-27
        accounts:
          - { id: a, type: checking, institution: Test, display_name: A }
          - { id: b, type: checking, institution: Test, display_name: B }
        postings:
          - txn:
              date: 2025-06-01
              description: bad
              derived_by: ingest
            legs:
              - { account_id: a, amount: 100.00 }
              - { account_id: b, amount: -50.00 }
    """)
    with pytest.raises(AssertionError) as ei:
        load_scenario_text(conn, text, fixture_path="(inline)", validate=True)
    assert "INV-1" in str(ei.value)


def test_load_from_disk(conn: sqlite3.Connection, tmp_path: Path):
    p = tmp_path / "fx.yaml"
    p.write_text(textwrap.dedent("""
        name: disk
        description: disk fixture
        as_of: 2026-04-27
        accounts:
          - { id: a, type: checking, institution: Test, display_name: A }
    """))
    load_scenario(conn, p)
    row = conn.execute(
        "SELECT id FROM accounts WHERE id NOT LIKE 'equity:%'"
    ).fetchone()
    assert tuple(row) == ("a",)
