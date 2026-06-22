"""Tests for the rules-based categorizer and transfer-pair detection."""
from __future__ import annotations

from pathlib import Path

from finance_pipeline.categorize import (
    _run_categorize,
    apply_transfer_pairs,
    find_transfer_pairs,
    load_rules,
)


def test_seed_txn_smoke(conn, seed_txn):
    tid = seed_txn(
        date="2026-04-01",
        description="x",
        postings=[("acct:a", -10), ("equity:unknown-counterparty", 10)],
    )
    assert tid > 0
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM transaction_items WHERE transaction_v2_id = ?",
        (tid,),
    ).fetchone()["n"]
    assert n == 1


def test_find_transfer_pairs_basic_mirror(conn, seed_txn):
    a = seed_txn(
        date="2026-04-01",
        description="from northwind",
        postings=[("acct:northwind", -500), ("equity:unknown-counterparty", 500)],
    )
    b = seed_txn(
        date="2026-04-02",
        description="to brokerage",
        postings=[("acct:brokerage", 500), ("equity:unknown-counterparty", -500)],
    )
    pairs = find_transfer_pairs(conn)
    assert len(pairs) == 1
    assert {pairs[0][0], pairs[0][1]} == {a, b}
    assert pairs[0][2] == 500.0


def test_apply_transfer_pairs_writes_tag_and_item_category(conn, seed_txn):
    a = seed_txn(
        date="2026-04-01",
        description="x",
        postings=[("acct:a", -100), ("equity:unknown-counterparty", 100)],
    )
    b = seed_txn(
        date="2026-04-01",
        description="y",
        postings=[("acct:b", 100), ("equity:unknown-counterparty", -100)],
    )
    apply_transfer_pairs(conn, [(a, b, 100.0)])
    conn.commit()

    rows = conn.execute(
        "SELECT id, tags FROM transactions_v2 WHERE id IN (?, ?)", (a, b)
    ).fetchall()
    for r in rows:
        assert "transfer-pair" in (r["tags"] or "")

    items = conn.execute(
        "SELECT category, category_source FROM transaction_items "
        "WHERE transaction_v2_id IN (?, ?)",
        (a, b),
    ).fetchall()
    assert len(items) == 2
    assert all(i["category"] == "Transfer" for i in items)
    assert all(i["category_source"] == "transfer-pair" for i in items)


def test_apply_transfer_pairs_idempotent(conn, seed_txn):
    a = seed_txn(
        date="2026-04-01",
        description="x",
        postings=[("acct:a", -1), ("equity:unknown-counterparty", 1)],
    )
    b = seed_txn(
        date="2026-04-01",
        description="y",
        postings=[("acct:b", 1), ("equity:unknown-counterparty", -1)],
    )
    apply_transfer_pairs(conn, [(a, b, 1.0)])
    apply_transfer_pairs(conn, [(a, b, 1.0)])
    conn.commit()
    tags_csv = conn.execute(
        "SELECT tags FROM transactions_v2 WHERE id = ?", (a,)
    ).fetchone()["tags"]
    tags = tags_csv.split(",") if tags_csv else []
    assert tags.count("transfer-pair") == 1


def test_find_transfer_pairs_skips_non_transfer_categorized(conn, seed_txn):
    seed_txn(
        date="2026-04-01",
        description="restaurant",
        postings=[("acct:northwind", -50), ("equity:unknown-counterparty", 50)],
        item_category="restaurants",
    )
    seed_txn(
        date="2026-04-01",
        description="refund",
        postings=[("acct:amex", 50), ("equity:unknown-counterparty", -50)],
        item_category="restaurants",
    )
    assert find_transfer_pairs(conn) == []


def test_find_transfer_pairs_includes_transfer_labeled(conn, seed_txn):
    a = seed_txn(
        date="2026-04-01",
        description="t",
        postings=[("acct:a", -10), ("equity:unknown-counterparty", 10)],
        item_category="Transfer",
    )
    b = seed_txn(
        date="2026-04-01",
        description="t",
        postings=[("acct:b", 10), ("equity:unknown-counterparty", -10)],
        item_category="transfer",
    )
    pairs = find_transfer_pairs(conn)
    assert len(pairs) == 1
    assert {pairs[0][0], pairs[0][1]} == {a, b}


def _write_rules(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "rules.yaml"
    p.write_text(body)
    return p


_UBER_RULES = """
categories:
  - restaurants
rules:
  - name: uber_eats
    when:
      - field: description
        op: contains
        value: UBER EATS
    then:
      - set: category
        value: restaurants
""".strip()


def test_categorize_writes_to_synthesized_item(conn, seed_txn, tmp_path):
    tid = seed_txn(
        date="2026-04-01",
        description="UBER EATS xyz",
        postings=[("acct:northwind", -25), ("equity:unknown-counterparty", 25)],
    )
    ruleset = load_rules(_write_rules(tmp_path, _UBER_RULES))
    stats = _run_categorize(conn, ruleset, dry_run=False, only_uncategorized=False)
    conn.commit()

    assert stats.matched == 1
    row = conn.execute(
        "SELECT category, category_source FROM transaction_items "
        "WHERE transaction_v2_id = ?",
        (tid,),
    ).fetchone()
    assert row["category"] == "restaurants"
    assert row["category_source"] == "rule"


def test_categorize_only_uncategorized_skips_categorized_txns(
    conn, seed_txn, tmp_path
):
    seed_txn(
        date="2026-04-01",
        description="UBER EATS already-set",
        postings=[("acct:northwind", -10), ("equity:unknown-counterparty", 10)],
        item_category="shopping",
    )
    fresh = seed_txn(
        date="2026-04-02",
        description="UBER EATS fresh",
        postings=[("acct:northwind", -12), ("equity:unknown-counterparty", 12)],
    )
    ruleset = load_rules(_write_rules(tmp_path, _UBER_RULES))
    stats = _run_categorize(conn, ruleset, dry_run=False, only_uncategorized=True)
    conn.commit()

    assert stats.processed == 1
    assert stats.matched == 1
    fresh_cat = conn.execute(
        "SELECT category FROM transaction_items WHERE transaction_v2_id = ?",
        (fresh,),
    ).fetchone()["category"]
    assert fresh_cat == "restaurants"


def test_categorize_does_not_clobber_existing_item_category(
    conn, seed_txn, tmp_path
):
    tid = seed_txn(
        date="2026-04-01",
        description="UBER EATS but user-set",
        postings=[("acct:northwind", -25), ("equity:unknown-counterparty", 25)],
        item_category="shopping",
    )
    # Mark the existing item as user-sourced so a sane categorizer won't touch it.
    conn.execute(
        "UPDATE transaction_items SET category_source = 'user' "
        "WHERE transaction_v2_id = ?",
        (tid,),
    )
    conn.commit()

    ruleset = load_rules(_write_rules(tmp_path, _UBER_RULES))
    _run_categorize(conn, ruleset, dry_run=False, only_uncategorized=False)
    conn.commit()

    row = conn.execute(
        "SELECT category, category_source FROM transaction_items "
        "WHERE transaction_v2_id = ?",
        (tid,),
    ).fetchone()
    assert row["category"] == "shopping"
    assert row["category_source"] == "user"
