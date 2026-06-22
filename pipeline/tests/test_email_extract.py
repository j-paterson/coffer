"""Pin the post-migration-032 extract.py prefilter: _has_txn_candidate
now reads from transactions_v2 JOIN postings (excluding equity legs)."""
from __future__ import annotations

from datetime import datetime

from finance_pipeline.emails import extract, senders


def _seed_txn(conn, date: str, amount: float, account_id: str = "live:a") -> int:
    cur = conn.execute(
        "INSERT INTO transactions_v2 (date, description, derived_by) VALUES (?, 'x', 'test')",
        (date,),
    )
    txn_id = cur.lastrowid
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) VALUES (?, ?, ?, 'USD')",
        (txn_id, account_id, -abs(amount)),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) "
        "VALUES (?, 'equity:opening-balance', ?, 'USD')",
        (txn_id, abs(amount)),
    )
    return txn_id


def test_has_candidate_finds_v2_match(conn, seed_account):
    seed_account("live:a", mode="live")
    _seed_txn(conn, "2026-04-10", 42.50)
    received = datetime.fromisoformat("2026-04-11T09:00:00")

    hit = extract._has_txn_candidate(conn, {42.50, 999.99}, received)
    # Largest-first ordering prefers 999.99, then falls back to 42.50.
    assert hit == 42.50


def test_has_candidate_skips_equity_only(conn, seed_account):
    """If the only matching posting is an equity leg, it shouldn't count
    — equity legs are bookkeeping, not real-world spending."""
    seed_account("live:a", mode="live")
    # Insert a txn but with *only* an equity posting at the target amount.
    cur = conn.execute(
        "INSERT INTO transactions_v2 (date, description, derived_by) "
        "VALUES ('2026-04-10', 'x', 'test')"
    )
    txn_id = cur.lastrowid
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) "
        "VALUES (?, 'equity:opening-balance', ?, 'USD')",
        (txn_id, 42.50),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) "
        "VALUES (?, 'live:a', ?, 'USD')",
        (txn_id, -1.00),  # user-side amount does NOT match the target
    )
    received = datetime.fromisoformat("2026-04-11T09:00:00")

    assert extract._has_txn_candidate(conn, {42.50}, received) is None


def test_has_candidate_none_on_empty_amounts(conn):
    received = datetime.fromisoformat("2026-04-11T09:00:00")
    assert extract._has_txn_candidate(conn, set(), received) is None


def test_has_candidate_respects_date_window(conn, seed_account):
    seed_account("live:a", mode="live")
    # Txn is far outside the ±7d window.
    _seed_txn(conn, "2025-01-01", 42.50)
    received = datetime.fromisoformat("2026-04-11T09:00:00")
    assert extract._has_txn_candidate(conn, {42.50}, received) is None


def test_subscription_heuristic_ignores_plan_in_items():
    # Regression: an invoice that says "per plan" or "framing per plan" in
    # a line item used to trip the subscription heuristic, turning a real
    # contractor into a skipped sender. Item descriptions are not signals.
    parsed = {
        "merchant": "TeamWork Home Designs",
        "items": [
            {"name": "Frame new soffit ceiling per plan", "unit_price": "$200.00"},
            {"name": "Demolition of linen closet", "unit_price": "$350.00"},
        ],
    }
    assert senders.looks_like_subscription(parsed, subject="Payment processed: Invoice #0002017") is False


def test_subscription_heuristic_catches_real_sub():
    parsed = {"merchant": "Google One", "items": [{"name": "Google One"}]}
    assert senders.looks_like_subscription(parsed, subject="Your Google One membership") is True
