"""Smoke test for backfill_investments.

backfill_investments reads eligible accounts + latest holdings from the
v2 ``positions`` / ``position_snapshots`` tables and writes synthesized
historical rows back into ``balance_assertions`` + ``position_snapshots``.
No v1 reads or writes remain.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date, timedelta

from finance_pipeline import backfill_prices, positions as positions_mod


@contextmanager
def _ctx(c):
    yield c


def test_backfill_investments_writes_v2(monkeypatch, conn, seed_account):
    seed_account("brokerage:1", type="brokerage", mode="live")
    # Seed the eligibility + latest-holdings signal via v2 tables.
    positions_mod.upsert_holding(
        conn,
        account_id="brokerage:1",
        symbol="VTSAX",
        as_of="2025-01-01",
        source="simplefin",
        value_usd=10000.0,
        quantity=100.0,
    )

    today = date.today()
    canned = {
        (today - timedelta(days=n)).isoformat(): 100.0 + n
        for n in range(8)
    }
    monkeypatch.setattr(backfill_prices.db, "connect", lambda *a, **kw: _ctx(conn))
    monkeypatch.setattr(backfill_prices.time, "sleep", lambda *a, **kw: None)
    monkeypatch.setattr(
        backfill_prices, "_fetch_daily_closes", lambda sym, days: canned
    )

    stats = backfill_prices.backfill_investments(days=7)

    assert stats.accounts == 1
    assert stats.balance_rows >= 3

    # v2 balance_assertions populated with synthesized history.
    n_assert = conn.execute(
        "SELECT COUNT(*) FROM balance_assertions WHERE account_id = 'brokerage:1' "
        "AND source = 'backfill:yfinance'"
    ).fetchone()[0]
    assert n_assert >= 3

    # v2 position_snapshots populated (today skipped to avoid clobbering live).
    pos = conn.execute(
        "SELECT id FROM positions WHERE account_id = 'brokerage:1' AND symbol = 'VTSAX'"
    ).fetchone()
    assert pos is not None
    n_snap = conn.execute(
        "SELECT COUNT(*) FROM position_snapshots WHERE position_id = ? "
        "AND source = 'backfill:yfinance'",
        (pos["id"],),
    ).fetchone()[0]
    assert n_snap >= 2


def test_backfill_investments_no_eligible_accounts_is_noop(monkeypatch, conn):
    monkeypatch.setattr(backfill_prices.db, "connect", lambda *a, **kw: _ctx(conn))
    stats = backfill_prices.backfill_investments(days=7)
    assert stats.accounts == 0
    assert stats.balance_rows == 0
