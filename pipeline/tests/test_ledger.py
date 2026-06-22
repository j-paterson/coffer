"""Ledger invariants — postings sum to zero, assertions are idempotent,
one-sided builds the canonical equity-counterparty pair."""

from __future__ import annotations

import json

import pytest

from finance_pipeline import ledger


def test_post_transaction_balanced(conn, seed_account):
    """A balanced two-leg transaction writes both postings."""
    seed_account("a", "A")
    seed_account("b", "B")
    txn_id = ledger.post_transaction(
        conn,
        date="2025-01-15",
        description="transfer",
        postings=[
            ledger.Posting(account_id="a", amount=-100.0),
            ledger.Posting(account_id="b", amount=100.0),
        ],
    )
    assert txn_id > 0
    rows = conn.execute(
        "SELECT account_id, amount FROM postings WHERE txn_id = ? ORDER BY amount",
        (txn_id,),
    ).fetchall()
    assert [(r[0], r[1]) for r in rows] == [("a", -100.0), ("b", 100.0)]


def test_post_transaction_unbalanced_raises(conn, seed_account):
    """An unbalanced posting set must raise — never silently corrupt."""
    seed_account("a", "A")
    seed_account("b", "B")
    with pytest.raises(ledger.LedgerError, match="don't balance"):
        ledger.post_transaction(
            conn,
            date="2025-01-15",
            description="bad",
            postings=[
                ledger.Posting(account_id="a", amount=-100.0),
                ledger.Posting(account_id="b", amount=99.0),
            ],
        )
    # And no postings should have been written.
    n = conn.execute("SELECT COUNT(*) FROM postings").fetchone()[0]
    assert n == 0


def test_post_transaction_single_posting_raises(conn, seed_account):
    """A txn with <2 postings is malformed by definition."""
    seed_account("a", "A")
    with pytest.raises(ledger.LedgerError, match=">=2"):
        ledger.post_transaction(
            conn,
            date="2025-01-15",
            description="loner",
            postings=[ledger.Posting(account_id="a", amount=0.0)],
        )


def test_post_transaction_balance_within_tolerance(conn, seed_account):
    """Sub-cent rounding is forgiven (TOLERANCE = $0.005)."""
    seed_account("a", "A")
    seed_account("b", "B")
    # Off by 0.003 — under the tolerance, should pass
    txn = ledger.post_transaction(
        conn,
        date="2025-01-15",
        description="rounding",
        postings=[
            ledger.Posting(account_id="a", amount=-100.001),
            ledger.Posting(account_id="b", amount=99.998),
        ],
    )
    assert txn > 0


def test_one_sided_returns_balanced_pair():
    postings = ledger.one_sided(
        account_id="a", amount=-50.0, payee="Coffee Shop", memo="latte"
    )
    assert len(postings) == 2
    assert postings[0].account_id == "a"
    assert postings[0].amount == -50.0
    assert postings[1].account_id == ledger.UNKNOWN_COUNTERPARTY
    assert postings[1].amount == 50.0
    assert postings[0].payee == "Coffee Shop"
    # Sum to zero by construction.
    assert sum(p.amount for p in postings) == 0


def test_record_event_idempotent(conn):
    """Re-recording the same (source, external_id) is a no-op."""
    raw_a = ledger.record_event(
        conn, source="simplefin", external_id="sf:1",
        payload={"amount": 50},
    )
    raw_b = ledger.record_event(
        conn, source="simplefin", external_id="sf:1",
        payload={"amount": 50},
    )
    assert raw_a is not None
    assert raw_b is None  # second call returned None — already present
    n = conn.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0]
    assert n == 1


def test_assert_balance_idempotent_upsert(conn, seed_account):
    """Same (account, date, source) updates rather than duplicates."""
    seed_account("a")
    ledger.assert_balance(
        conn, account_id="a", as_of="2025-01-01",
        expected_usd=1000.0, source="manual",
    )
    ledger.assert_balance(
        conn, account_id="a", as_of="2025-01-01",
        expected_usd=1500.0, source="manual",
    )
    rows = conn.execute(
        "SELECT expected_usd FROM balance_assertions WHERE account_id='a'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 1500.0


def test_assert_balance_distinct_sources_coexist(conn, seed_account):
    """Two sources can assert different values for the same date."""
    seed_account("a")
    ledger.assert_balance(
        conn, account_id="a", as_of="2025-01-01",
        expected_usd=1000.0, source="manual",
    )
    ledger.assert_balance(
        conn, account_id="a", as_of="2025-01-01",
        expected_usd=1100.0, source="simplefin",
    )
    rows = conn.execute(
        "SELECT source, expected_usd FROM balance_assertions WHERE account_id='a' ORDER BY source"
    ).fetchall()
    assert [(r[0], r[1]) for r in rows] == [("manual", 1000.0), ("simplefin", 1100.0)]
