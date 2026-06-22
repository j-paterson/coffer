"""Pin migration 048 behavior: legacy mixed-case category/subcategory
values on transaction_items collapse to canonical (lower, trimmed,
hyphens→underscores) form."""
from __future__ import annotations

from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).resolve().parents[2]
    / "db"
    / "migrations"
    / "048_normalize_item_categories.sql"
)


def _seed_item(conn, item_id: int, category: str | None,
               subcategory: str | None = None) -> None:
    conn.execute(
        """
        INSERT INTO transaction_items
            (id, line_no, name, category, subcategory)
        VALUES (?, 1, 'test', ?, ?)
        """,
        (item_id, category, subcategory),
    )


def _apply_migration(conn) -> None:
    conn.executescript(MIGRATION_PATH.read_text())


def test_lowercases_capitalized_category(conn):
    _seed_item(conn, 1, "Restaurants")
    _seed_item(conn, 2, "restaurants")
    _seed_item(conn, 3, "Pets")
    _apply_migration(conn)
    rows = conn.execute(
        "SELECT id, category FROM transaction_items ORDER BY id"
    ).fetchall()
    assert [r["category"] for r in rows] == ["restaurants", "restaurants", "pets"]


def test_replaces_hyphens_with_underscores(conn):
    _seed_item(conn, 1, "investment-loss")
    _seed_item(conn, 2, "Auto-Repair")
    _apply_migration(conn)
    rows = conn.execute(
        "SELECT id, category FROM transaction_items ORDER BY id"
    ).fetchall()
    assert [r["category"] for r in rows] == ["investment_loss", "auto_repair"]


def test_trims_whitespace(conn):
    _seed_item(conn, 1, "  Groceries  ")
    _apply_migration(conn)
    row = conn.execute(
        "SELECT category FROM transaction_items WHERE id = 1"
    ).fetchone()
    assert row["category"] == "groceries"


def test_leaves_already_canonical_unchanged(conn):
    _seed_item(conn, 1, "groceries")
    _seed_item(conn, 2, "investment_loss")
    _apply_migration(conn)
    rows = conn.execute(
        "SELECT id, category FROM transaction_items ORDER BY id"
    ).fetchall()
    assert [r["category"] for r in rows] == ["groceries", "investment_loss"]


def test_preserves_null_and_empty(conn):
    _seed_item(conn, 1, None)
    _seed_item(conn, 2, "")
    _apply_migration(conn)
    rows = conn.execute(
        "SELECT id, category FROM transaction_items ORDER BY id"
    ).fetchall()
    assert rows[0]["category"] is None
    assert rows[1]["category"] == ""


def test_normalizes_subcategory_too(conn):
    _seed_item(conn, 1, "groceries", subcategory="Delivery")
    _seed_item(conn, 2, "fees", subcategory="Subscription")
    _apply_migration(conn)
    rows = conn.execute(
        "SELECT id, subcategory FROM transaction_items ORDER BY id"
    ).fetchall()
    assert [r["subcategory"] for r in rows] == ["delivery", "subscription"]


def test_idempotent(conn):
    _seed_item(conn, 1, "Restaurants")
    _apply_migration(conn)
    _apply_migration(conn)  # second run must be a no-op
    row = conn.execute(
        "SELECT category FROM transaction_items WHERE id = 1"
    ).fetchone()
    assert row["category"] == "restaurants"
