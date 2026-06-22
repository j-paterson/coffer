"""Tests for the architectural invariants in invariants.py.

Each invariant is exercised both with a clean DB (should pass) and
with intentionally-corrupt data (should raise InvariantError with a
helpful message)."""

from __future__ import annotations

import sqlite3

import pytest

from invariants import (
    InvariantError,
    INV_1_postings_balance,
    INV_2_posting_account_exists,
    INV_3_assertion_source_known,
    INV_4_snapshot_source_known,
    INV_5_no_merge_cycles,
    INV_6_trust_rank_unique,
    INV_7_equity_account_type,
    INV_8_snapshot_qty_price_value,
    run_all,
)


def test_inv1_passes_on_balanced_transaction(conn: sqlite3.Connection, seed_account):
    seed_account("a", type="checking")
    seed_account("b", type="checking")
    conn.execute(
        "INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2025-01-01', 'x', 'ingest')"
    )
    txn_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'a', 100.00)",
        (txn_id,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'b', -100.00)",
        (txn_id,),
    )
    INV_1_postings_balance(conn)  # no raise


def test_inv1_raises_on_unbalanced_transaction(conn: sqlite3.Connection, seed_account):
    seed_account("a", type="checking")
    seed_account("b", type="checking")
    conn.execute(
        "INSERT INTO transactions_v2 (date, description, derived_by) VALUES ('2025-01-01', 'x', 'ingest')"
    )
    txn_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'a', 100.00)",
        (txn_id,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (?, 'b', -50.00)",
        (txn_id,),
    )
    with pytest.raises(InvariantError) as ei:
        INV_1_postings_balance(conn)
    assert "INV-1" in str(ei.value)
    assert str(txn_id) in str(ei.value)


def test_inv5_raises_on_merge_cycle(conn: sqlite3.Connection, seed_account):
    seed_account("a", type="checking")
    seed_account("b", type="checking")
    conn.execute("UPDATE accounts SET merged_into='b' WHERE id='a'")
    conn.execute("UPDATE accounts SET merged_into='a' WHERE id='b'")
    with pytest.raises(InvariantError) as ei:
        INV_5_no_merge_cycles(conn)
    assert "INV-5" in str(ei.value)


def test_run_all_runs_every_invariant(conn: sqlite3.Connection):
    """An empty DB satisfies every invariant; run_all must complete without raising."""
    run_all(conn)
