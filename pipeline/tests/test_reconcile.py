"""Reconcile v1 (manual) → v2 (live) account merge semantics.

apply_matches must delete every child row that references a manual
account before the account row itself can go — SQLite's FK enforcement
blocks the account DELETE otherwise. The sync pipeline calls this on
every SimpleFIN run; a missed child table silently breaks sync.
"""
from __future__ import annotations

from finance_pipeline import reconcile
from finance_pipeline.reconcile import ReconcileMatch


def _match(manual_id: str, live_id: str) -> ReconcileMatch:
    return ReconcileMatch(
        kubera_id=manual_id,
        kubera_name="Manual",
        kubera_type="checking",
        simplefin_id=live_id,
        simplefin_name="Live",
        simplefin_type="checking",
        matched_on="test",
    )


def test_apply_matches_clears_reconciliation_notes(conn, seed_account):
    """Regression: reconciliation_notes FKs used to block the delete."""
    seed_account("live:a", mode="live")
    seed_account("manual:a", mode="manual")
    conn.execute(
        "INSERT INTO reconciliation_notes (account_id, as_of, kind, detail) "
        "VALUES (?, '2025-01-01', 'pad', '{}')",
        ("manual:a",),
    )

    n = reconcile.apply_matches(conn, [_match("manual:a", "live:a")])

    assert n == 1
    assert conn.execute("SELECT 1 FROM accounts WHERE id = 'manual:a'").fetchone() is None
    assert conn.execute("SELECT 1 FROM accounts WHERE id = 'live:a'").fetchone() is not None
    assert conn.execute(
        "SELECT COUNT(*) FROM reconciliation_notes WHERE account_id = 'manual:a'"
    ).fetchone()[0] == 0


def test_apply_matches_clears_every_child_table(conn, seed_account):
    """All FK-bearing child tables get cleared, not just balances/holdings."""
    seed_account("live:b", mode="live", type="credit")
    seed_account("manual:b", mode="manual", type="credit")
    conn.execute(
        "INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) "
        "VALUES ('manual:b', '2025-01-01', 100.0, 'kubera')"
    )
    conn.execute(
        "INSERT INTO transactions_v2 (id, date, description, derived_by) "
        "VALUES (1, '2025-01-01', 'test', 'ingest')"
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (1, 'manual:b', -50.0)"
    )
    conn.execute(
        "INSERT INTO debt_terms (account_id, apr) VALUES ('manual:b', 0.2)"
    )
    conn.execute(
        "INSERT INTO positions (account_id, chain, contract_address, symbol) "
        "VALUES ('manual:b', '', '', 'USD')"
    )

    reconcile.apply_matches(conn, [_match("manual:b", "live:b")])

    for table in ("balance_assertions", "postings", "debt_terms", "positions"):
        n = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE account_id = 'manual:b'"
        ).fetchone()[0]
        assert n == 0, f"{table} still has rows for archived manual account"


def test_apply_matches_nulls_merged_into_self_ref(conn, seed_account):
    """An archived account that's someone else's merge target must not
    trip the merged_into FK when it's deleted."""
    seed_account("live:new", mode="live")
    seed_account("manual:gone", mode="manual")
    seed_account("live:target", mode="live", merged_into="manual:gone")

    reconcile.apply_matches(conn, [_match("manual:gone", "live:new")])

    row = conn.execute(
        "SELECT merged_into FROM accounts WHERE id = 'live:target'"
    ).fetchone()
    assert row["merged_into"] is None
    assert conn.execute("SELECT 1 FROM accounts WHERE id = 'manual:gone'").fetchone() is None


def test_apply_matches_inherits_manual_type_on_cross_group_mismatch(conn, seed_account):
    """When Kubera says 'checking' and SimpleFIN says 'brokerage', trust
    Kubera — see _choose_type docstring."""
    seed_account("live:sfc", mode="live", type="brokerage")
    seed_account("manual:sfc", mode="manual", type="checking")

    match = ReconcileMatch(
        kubera_id="manual:sfc", kubera_name="m", kubera_type="checking",
        simplefin_id="live:sfc", simplefin_name="s", simplefin_type="brokerage",
        matched_on="test",
    )
    reconcile.apply_matches(conn, [match])

    row = conn.execute("SELECT type FROM accounts WHERE id = 'live:sfc'").fetchone()
    assert row["type"] == "checking"


def test_apply_matches_empty_is_noop(conn):
    assert reconcile.apply_matches(conn, []) == 0


# ---------------------------------------------------------------- dedup
#
# Cross-source dedup collapses v2 txns that represent the same real-world
# event observed through different providers (Chase CSV + SimpleFIN,
# CoinTracker CSV + Zerion, etc.). The invariant: only merge when the
# supporting ``raw_events.source`` values genuinely differ. Legitimate
# repeat charges from the same provider (two Zelles the same day) must
# survive.

import json

from finance_pipeline.reconcile import (
    DedupStats,
    dedup_transactions,
    find_duplicate_clusters,
)


def _seed_txn_with_source(
    conn,
    date: str,
    amount: float,
    source: str,
    external_id: str,
    account_id: str = "live:a",
    description: str = "AMAZON.COM",
    payee: str = "AMAZON",
) -> int:
    """Seed a v2 txn + user-side + equity postings + raw_events + event_links.

    Returns the txn id. ``amount`` is the *spend* (user-side is stored as
    its negation; receipt totals + |posting| should match)."""
    cur = conn.execute(
        "INSERT INTO transactions_v2 (date, description, derived_by) VALUES (?, ?, 'test')",
        (date, description),
    )
    txn_id = cur.lastrowid
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency, payee) "
        "VALUES (?, ?, ?, 'USD', ?)",
        (txn_id, account_id, -abs(amount), payee),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) "
        "VALUES (?, 'equity:opening-balance', ?, 'USD')",
        (txn_id, abs(amount)),
    )
    cur = conn.execute(
        "INSERT INTO raw_events (source, external_id, payload) VALUES (?, ?, '{}')",
        (source, external_id),
    )
    raw_id = cur.lastrowid
    conn.execute(
        "INSERT INTO event_links (txn_id, raw_id) VALUES (?, ?)", (txn_id, raw_id)
    )
    return txn_id


def test_dedup_collapses_cross_source_pair(conn, seed_account):
    seed_account("live:a", mode="live")
    canon = _seed_txn_with_source(conn, "2026-04-10", 80.06, "chase-statement", "c-1")
    loser = _seed_txn_with_source(conn, "2026-04-11", 80.06, "simplefin", "s-1")

    stats = dedup_transactions(conn, window_days=3)

    assert stats.clusters == 1
    assert stats.merged_losers == 1
    # loser row is gone; postings cascade-drop.
    assert conn.execute(
        "SELECT 1 FROM transactions_v2 WHERE id = ?", (loser,)
    ).fetchone() is None
    assert conn.execute(
        "SELECT COUNT(*) FROM postings WHERE txn_id = ?", (loser,)
    ).fetchone()[0] == 0
    # event_links from both sources now live on canonical.
    sources = {
        r["source"] for r in conn.execute(
            "SELECT re.source FROM event_links el "
            "JOIN raw_events re ON re.id = el.raw_id WHERE el.txn_id = ?",
            (canon,),
        ).fetchall()
    }
    assert sources == {"chase-statement", "simplefin"}
    # audit row records the merge.
    note = conn.execute(
        "SELECT detail FROM reconciliation_notes WHERE kind = 'dedup'"
    ).fetchone()
    assert note is not None
    detail = json.loads(note["detail"])
    assert detail["canonical_txn_v2_id"] == canon
    assert detail["merged_txn_v2_ids"] == [loser]


def test_dedup_preserves_same_source_pair(conn, seed_account):
    """Regression guard: two real Zelles to the same friend same day from
    SimpleFIN are two real events — must NOT be merged."""
    seed_account("live:a", mode="live")
    a = _seed_txn_with_source(
        conn, "2026-04-10", 450.00, "simplefin", "sf-a",
        description="ZELLE TO NICOLAS", payee="NICOLAS",
    )
    b = _seed_txn_with_source(
        conn, "2026-04-10", 450.00, "simplefin", "sf-b",
        description="ZELLE TO NICOLAS", payee="NICOLAS",
    )

    clusters = find_duplicate_clusters(conn, window_days=3)
    stats = dedup_transactions(conn, window_days=3)

    assert clusters == []
    assert stats.clusters == 0
    assert stats.merged_losers == 0
    # Both txns survive.
    assert conn.execute(
        "SELECT COUNT(*) FROM transactions_v2 WHERE id IN (?, ?)", (a, b)
    ).fetchone()[0] == 2


def test_dedup_refuses_when_audit_missing(conn, seed_account):
    """If either side has no event_links, we can't vouch for its provider
    identity — refuse to merge (fail-safe)."""
    seed_account("live:a", mode="live")
    _seed_txn_with_source(conn, "2026-04-10", 20.00, "chase-statement", "c-x")
    # Second txn has no raw_events/event_links at all.
    cur = conn.execute(
        "INSERT INTO transactions_v2 (date, description, derived_by) "
        "VALUES ('2026-04-10', 'AMAZON.COM', 'manual')"
    )
    txn_b = cur.lastrowid
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) "
        "VALUES (?, 'live:a', -20.00, 'USD')",
        (txn_b,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) "
        "VALUES (?, 'equity:opening-balance', 20.00, 'USD')",
        (txn_b,),
    )

    stats = dedup_transactions(conn, window_days=3)
    assert stats.clusters == 0
    assert stats.merged_losers == 0


def test_dedup_repoints_items_and_emails(conn, seed_account):
    seed_account("live:a", mode="live")
    canon = _seed_txn_with_source(conn, "2026-04-10", 42.00, "chase-statement", "c-1")
    loser = _seed_txn_with_source(conn, "2026-04-11", 42.00, "simplefin", "s-1")
    conn.execute(
        """
        INSERT INTO emails (id, received_at, from_addr, subject, raw_path,
                            merchant, receipt_date, total_usd,
                            extraction_status, match_status, transaction_v2_id)
        VALUES ('em-1', '2026-04-11T00:00', 'x@y', 's', 'r', 'Amazon',
                '2026-04-11', 42.00, 'extracted', 'strict', ?)
        """,
        (loser,),
    )
    conn.execute(
        "INSERT INTO transaction_items (email_id, line_no, name, transaction_v2_id) "
        "VALUES ('em-1', 1, 'Book', ?)",
        (loser,),
    )

    stats = dedup_transactions(conn, window_days=3)

    assert stats.emails_repointed == 1
    assert stats.items_repointed == 1
    assert conn.execute(
        "SELECT transaction_v2_id FROM emails WHERE id = 'em-1'"
    ).fetchone()["transaction_v2_id"] == canon
    assert conn.execute(
        "SELECT transaction_v2_id FROM transaction_items WHERE email_id = 'em-1'"
    ).fetchone()["transaction_v2_id"] == canon


def test_dedup_unions_tags_and_picks_smallest_id_canonical(conn, seed_account):
    seed_account("live:a", mode="live")
    a = _seed_txn_with_source(conn, "2026-04-10", 10.00, "chase-statement", "c-1")
    b = _seed_txn_with_source(conn, "2026-04-11", 10.00, "simplefin", "s-1")
    conn.execute("UPDATE transactions_v2 SET tags = 'receipt-only' WHERE id = ?", (a,))
    conn.execute(
        "UPDATE transactions_v2 SET tags = 'needs-review,trip-munich' WHERE id = ?",
        (b,),
    )

    stats = dedup_transactions(conn, window_days=3)

    assert stats.merged_losers == 1
    assert a < b  # sanity: a is smallest id
    survivor = conn.execute(
        "SELECT id, tags FROM transactions_v2 WHERE id IN (?, ?)", (a, b)
    ).fetchall()
    assert len(survivor) == 1
    assert survivor[0]["id"] == a
    assert set(survivor[0]["tags"].split(",")) == {
        "receipt-only", "needs-review", "trip-munich"
    }


def test_dedup_dry_run_writes_nothing(conn, seed_account):
    seed_account("live:a", mode="live")
    _seed_txn_with_source(conn, "2026-04-10", 99.00, "chase-statement", "c-1")
    _seed_txn_with_source(conn, "2026-04-11", 99.00, "simplefin", "s-1")

    stats = dedup_transactions(conn, window_days=3, dry_run=True)

    assert stats.clusters == 1
    assert stats.merged_losers == 0
    assert conn.execute("SELECT COUNT(*) FROM transactions_v2").fetchone()[0] == 2
    assert conn.execute(
        "SELECT COUNT(*) FROM reconciliation_notes WHERE kind = 'dedup'"
    ).fetchone()[0] == 0


def test_dedup_respects_window(conn, seed_account):
    """Matches outside the ±window_days band don't cluster."""
    seed_account("live:a", mode="live")
    _seed_txn_with_source(conn, "2026-04-01", 77.00, "chase-statement", "c-1")
    _seed_txn_with_source(conn, "2026-04-15", 77.00, "simplefin", "s-1")

    stats = dedup_transactions(conn, window_days=3)
    assert stats.clusters == 0


def test_dedup_empty_db_is_noop(conn):
    stats = dedup_transactions(conn, window_days=3)
    assert stats == DedupStats()


def test_dedup_refuses_transitive_same_source_collision(conn, seed_account):
    """Regression: union-find can transitively pull two same-source rows
    into a cluster via a shared cross-source partner. Two SimpleFIN
    Zelles to the same friend tied to one Schwab row must NOT collapse —
    the Zelles are legitimate separate payments."""
    seed_account("live:a", mode="live")
    _seed_txn_with_source(
        conn, "2026-03-18", 450.00, "schwab", "sc-1",
        description="ZELLE FROM NICOLAS", payee="NICOLAS",
    )
    _seed_txn_with_source(
        conn, "2026-03-18", 450.00, "simplefin", "sf-a",
        description="ZELLE FROM NICOLAS", payee="NICOLAS",
    )
    _seed_txn_with_source(
        conn, "2026-03-18", 450.00, "simplefin", "sf-b",
        description="ZELLE FROM NICOLAS", payee="NICOLAS",
    )

    clusters = find_duplicate_clusters(conn, window_days=3)
    stats = dedup_transactions(conn, window_days=3)

    assert clusters == []
    assert stats.merged_losers == 0
    assert conn.execute("SELECT COUNT(*) FROM transactions_v2").fetchone()[0] == 3
