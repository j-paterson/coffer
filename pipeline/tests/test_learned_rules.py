"""Tests for forward-application of learned rules (user_item_rules).

The server records a keyword->category mapping every time a user sets a
category, and migration 011 documents the intent that "future items
containing <keyword> auto-classify" — but nothing read the table back, so
learned categorizations did not carry over to newly-synced transactions.
apply_learned_rules closes that gap.
"""
from __future__ import annotations

from finance_pipeline.categorize import apply_learned_rules, canonical_category


def _learn(conn, keyword, category, hits=1):
    conn.execute(
        "INSERT INTO user_item_rules (keyword, category, hits) VALUES (?, ?, ?)",
        (keyword, category, hits),
    )


def test_fills_uncategorized_by_keyword(conn, seed_txn):
    _learn(conn, "hopdoddy", "Restaurants", hits=3)
    tid = seed_txn(
        date="2026-01-01",
        description="UBER HOPDODDYBURGE SAN FRANCISCO CA",
        postings=[("checking:x", -21.0), ("equity:unknown-counterparty", 21.0)],
        item_category=None,
    )
    conn.commit()

    assert apply_learned_rules(conn) == 1
    row = conn.execute(
        "SELECT category, category_source FROM transaction_items "
        "WHERE transaction_v2_id = ?",
        (tid,),
    ).fetchone()
    assert row["category"] == "Restaurants"
    assert row["category_source"] == "learned"


def test_never_overrides_existing_or_user(conn, seed_txn):
    _learn(conn, "coffee", "Coffee")
    # Already categorized (e.g. by rules.yaml) — must be left alone.
    t_set = seed_txn(
        date="2026-01-01",
        description="COFFEE SHOP",
        postings=[("checking:x", -5.0), ("equity:unknown-counterparty", 5.0)],
        item_category="Restaurants",
    )
    # Deliberately cleared by the user (NULL category, source 'user').
    t_user = seed_txn(
        date="2026-01-02",
        description="COFFEE PLACE",
        postings=[("checking:x", -6.0), ("equity:unknown-counterparty", 6.0)],
        item_category=None,
    )
    conn.execute(
        "UPDATE transaction_items SET category_source = 'user' "
        "WHERE transaction_v2_id = ?",
        (t_user,),
    )
    conn.commit()

    apply_learned_rules(conn)

    assert conn.execute(
        "SELECT category FROM transaction_items WHERE transaction_v2_id = ?",
        (t_set,),
    ).fetchone()["category"] == "Restaurants"
    user_row = conn.execute(
        "SELECT category, category_source FROM transaction_items "
        "WHERE transaction_v2_id = ?",
        (t_user,),
    ).fetchone()
    assert user_row["category"] is None
    assert user_row["category_source"] == "user"


def test_higher_hit_keyword_wins_conflict(conn, seed_txn):
    # Same keyword learned to two categories; the higher-hit one should win,
    # and the lower-hit rule must not overwrite an already-applied result.
    _learn(conn, "market", "Groceries", hits=10)
    _learn(conn, "market", "Shopping", hits=1)
    tid = seed_txn(
        date="2026-01-01",
        description="CORNER MARKET",
        postings=[("checking:x", -12.0), ("equity:unknown-counterparty", 12.0)],
        item_category=None,
    )
    conn.commit()

    apply_learned_rules(conn)
    assert conn.execute(
        "SELECT category FROM transaction_items WHERE transaction_v2_id = ?",
        (tid,),
    ).fetchone()["category"] == "Groceries"


def test_canonical_category_normalizes_case_and_legacy():
    # case-only
    assert canonical_category("restaurants") == "Restaurants"
    assert canonical_category("SHOPPING") == "Shopping"
    # legacy aliases → canonical bucket (matches migration 053)
    assert canonical_category("grocery") == "Groceries"
    assert canonical_category("vehicle") == "Auto"
    assert canonical_category("debt_payment") == "Transfer"
    # already canonical is stable
    assert canonical_category("Restaurants") == "Restaurants"
    # empty/None
    assert canonical_category(None) is None
    assert canonical_category("   ") is None


def test_learned_lowercase_category_is_stored_canonical(conn, seed_txn):
    # user_item_rules carries the old app's lowercase value; the applied
    # category must be canonical so it doesn't split the Spending bucket.
    _learn(conn, "hopdoddy", "restaurants")
    tid = seed_txn(
        date="2026-01-01",
        description="HOPDODDY BURGER BAR",
        postings=[("checking:x", -15.0), ("equity:unknown-counterparty", 15.0)],
        item_category=None,
    )
    conn.commit()
    apply_learned_rules(conn)
    assert conn.execute(
        "SELECT category FROM transaction_items WHERE transaction_v2_id = ?",
        (tid,),
    ).fetchone()["category"] == "Restaurants"


def test_dry_run_counts_without_writing(conn, seed_txn):
    _learn(conn, "hopdoddy", "Restaurants")
    tid = seed_txn(
        date="2026-01-01",
        description="HOPDODDY BURGER BAR",
        postings=[("checking:x", -15.0), ("equity:unknown-counterparty", 15.0)],
        item_category=None,
    )
    conn.commit()

    assert apply_learned_rules(conn, dry_run=True) == 1
    # Nothing written.
    assert conn.execute(
        "SELECT category FROM transaction_items WHERE transaction_v2_id = ?",
        (tid,),
    ).fetchone()["category"] is None
