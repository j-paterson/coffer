"""Tests for trip clustering against item-level Travel categories."""
from __future__ import annotations

from finance_pipeline.trips import find_trips


def test_find_trips_clusters_travel_items(conn, seed_txn):
    seed_txn(
        date="2026-03-10",
        description="DELTA AIR LINES",
        postings=[("acct:northwind", -800), ("equity:unknown-counterparty", 800)],
        item_category="Travel",
    )
    seed_txn(
        date="2026-03-12",
        description="MARRIOTT BANFF",
        postings=[("acct:northwind", -400), ("equity:unknown-counterparty", 400)],
        item_category="Travel",
    )
    seed_txn(
        date="2026-04-15",
        description="UNITED AIRLINES",
        postings=[("acct:northwind", -300), ("equity:unknown-counterparty", 300)],
        item_category="travel",
    )
    trips = find_trips(conn)
    assert len(trips) == 2
    assert {t.start_date for t in trips} == {"2026-03-10", "2026-04-15"}


def test_find_trips_ignores_non_travel(conn, seed_txn):
    seed_txn(
        date="2026-03-10",
        description="grocery",
        postings=[("acct:northwind", -50), ("equity:unknown-counterparty", 50)],
        item_category="grocery",
    )
    assert find_trips(conn) == []
