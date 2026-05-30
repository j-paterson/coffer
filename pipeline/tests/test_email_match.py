"""Pin the post-migration-032 match.py behaviour: writes v2 txn ids
to emails.transaction_v2_id and transaction_items.transaction_v2_id,
and reads candidates from transactions_v2 JOIN postings."""
from __future__ import annotations

from contextlib import contextmanager

from finance_pipeline.emails import match


@contextmanager
def _ctx(c):
    yield c


def _seed_txn(conn, date: str, amount: float, description: str = "STARBUCKS #1234",
              payee: str = "STARBUCKS", account_id: str = "live:a") -> int:
    """Create a transactions_v2 row with user + equity postings, return id."""
    cur = conn.execute(
        "INSERT INTO transactions_v2 (date, description, derived_by) VALUES (?, ?, ?)",
        (date, description, "test"),
    )
    txn_id = cur.lastrowid
    # user-side leg (spend is negative on user account)
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency, payee) "
        "VALUES (?, ?, ?, 'USD', ?)",
        (txn_id, account_id, -abs(amount), payee),
    )
    # equity balancing leg
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) "
        "VALUES (?, 'equity:opening-balance', ?, 'USD')",
        (txn_id, abs(amount)),
    )
    return txn_id


def _seed_email(conn, email_id: str, total: float, merchant: str,
                receipt_date: str, received_at: str | None = None) -> None:
    conn.execute(
        """
        INSERT INTO emails (id, received_at, from_addr, subject, raw_path,
                            merchant, receipt_date, total_usd,
                            extraction_status, match_status)
        VALUES (?, ?, 'x@y.com', 'subj', 'raw/x.eml', ?, ?, ?,
                'extracted', 'unmatched')
        """,
        (email_id, received_at or (receipt_date + "T12:00:00"), merchant,
         receipt_date, total),
    )


def test_match_writes_v2_id_on_strict_hit(monkeypatch, conn, seed_account):
    seed_account("live:a", mode="live")
    txn_id = _seed_txn(conn, "2026-04-10", 12.47, "STARBUCKS #1234", "STARBUCKS")
    _seed_email(conn, "em-1", 12.47, "Starbucks", "2026-04-10")
    # Plus a line item that should cascade to the v2 id.
    conn.execute(
        "INSERT INTO transaction_items (email_id, line_no, name) "
        "VALUES ('em-1', 1, 'Latte')",
    )

    monkeypatch.setattr(match, "connect", lambda *a, **kw: _ctx(conn))

    stats = match.match_all()

    assert stats.strict == 1
    row = conn.execute(
        "SELECT match_status, transaction_v2_id FROM emails WHERE id = 'em-1'"
    ).fetchone()
    assert row["match_status"] == "strict"
    assert row["transaction_v2_id"] == txn_id
    item = conn.execute(
        "SELECT transaction_v2_id FROM transaction_items WHERE email_id = 'em-1'"
    ).fetchone()
    assert item["transaction_v2_id"] == txn_id


def test_match_ignores_equity_postings(monkeypatch, conn, seed_account):
    """Only the non-equity leg should surface as a candidate — otherwise
    every txn would match twice and inflate duplicates."""
    seed_account("live:a", mode="live")
    _seed_txn(conn, "2026-04-10", 50.00)
    _seed_email(conn, "em-2", 50.00, "Acme", "2026-04-10")

    monkeypatch.setattr(match, "connect", lambda *a, **kw: _ctx(conn))
    stats = match.match_all()

    # Single candidate → strict match (no ambiguity from the equity leg).
    assert stats.strict == 1
    assert stats.uncertain == 0


def test_match_none_when_no_candidate(monkeypatch, conn, seed_account):
    seed_account("live:a", mode="live")
    # Txn exists but at a different amount entirely.
    _seed_txn(conn, "2026-04-10", 5.00)
    _seed_email(conn, "em-3", 500.00, "Expensive", "2026-04-10")

    monkeypatch.setattr(match, "connect", lambda *a, **kw: _ctx(conn))
    stats = match.match_all()

    assert stats.none == 1
    row = conn.execute(
        "SELECT match_status, transaction_v2_id FROM emails WHERE id = 'em-3'"
    ).fetchone()
    assert row["match_status"] == "none"
    assert row["transaction_v2_id"] is None


def test_match_fuzzy_picks_merchant_winner(monkeypatch, conn, seed_account):
    """Two txns within the fuzzy window at similar amounts; merchant
    overlap should elect a confident winner (status 'fuzzy')."""
    seed_account("live:a", mode="live")
    seed_account("live:b", mode="live")
    _seed_txn(conn, "2026-04-08", 100.00, "CHIPOTLE 0012", "CHIPOTLE",
              account_id="live:a")
    _seed_txn(conn, "2026-04-09", 102.00, "MYSTERY CAFE", "MYSTERY",
              account_id="live:b")
    _seed_email(conn, "em-4", 101.00, "Chipotle", "2026-04-08")

    monkeypatch.setattr(match, "connect", lambda *a, **kw: _ctx(conn))
    stats = match.match_all()

    assert stats.fuzzy == 1
    assert stats.uncertain == 0
