"""Tests for the `reconcile transfers` merge path (relink counterparties).

Regression: relink_transfer_counterparties deleted the loser transaction
without repointing its transaction_items (and emails), which have a
non-cascading FK to transactions_v2 — so the DELETE failed with a
FOREIGN KEY constraint error on any real-world transfer pair (legs carry
items). The dedup path repoints these; relink must too.
"""
from __future__ import annotations

from finance_pipeline.categorize import relink_transfer_counterparties


def test_relink_deletes_loser_and_repoints_items(conn, seed_txn):
    # Two one-sided legs of a $5,000 transfer; each leg has an item, as all
    # real transactions do (migration 043 synthesis). FKs are ON in conftest.
    a = seed_txn(
        date="2026-01-01",
        description="Transfer to savings",
        postings=[("checking:x", -5000.0), ("equity:unknown-counterparty", 5000.0)],
        item_category="Uncategorized",
    )
    b = seed_txn(
        date="2026-01-01",
        description="Transfer from checking",
        postings=[("savings:y", 5000.0), ("equity:unknown-counterparty", -5000.0)],
        item_category="Uncategorized",
    )
    canonical, loser = min(a, b), max(a, b)

    # Previously raised sqlite3.IntegrityError: FOREIGN KEY constraint failed.
    n = relink_transfer_counterparties(conn, [(a, b, 5000.0)])
    assert n == 1

    # Loser gone; nothing left dangling at its id.
    assert conn.execute(
        "SELECT COUNT(*) FROM transactions_v2 WHERE id = ?", (loser,)
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM transaction_items WHERE transaction_v2_id = ?", (loser,)
    ).fetchone()[0] == 0

    # Canonical now carries both real legs → structurally a transfer
    # (excluded from spending), no longer a one-sided spend.
    real_legs = conn.execute(
        "SELECT COUNT(*) FROM postings "
        "WHERE txn_id = ? AND account_id NOT LIKE 'equity:%'",
        (canonical,),
    ).fetchone()[0]
    assert real_legs == 2
