"""Pin migration 049 behavior: legacy transaction_items rows with
"$X.XX" / "" stored in the REAL line_total/unit_price/quantity columns
get coerced to numeric REAL or NULL.

These rows came from older email parsings before _parse_amount was
applied; SQLite's lax typing accepted the strings. Spending aggregates
that use SUM(line_total) treat "" as 0 and "$X.XX" * 1 as 0, so dozens
of categories were rendering $0 in the dashboard donut.
"""
from __future__ import annotations

from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).resolve().parents[2]
    / "db"
    / "migrations"
    / "049_coerce_item_amounts.sql"
)


def _seed(conn, item_id: int, **cols) -> None:
    keys = ["id", "line_no", "name"] + list(cols.keys())
    placeholders = ",".join(["?"] * len(keys))
    values = [item_id, 1, "test"] + list(cols.values())
    conn.execute(
        f"INSERT INTO transaction_items ({','.join(keys)}) VALUES ({placeholders})",
        values,
    )


def _apply(conn) -> None:
    conn.executescript(MIGRATION_PATH.read_text())


def test_parses_dollar_strings_in_line_total(conn):
    _seed(conn, 1, line_total="$249.95")
    _seed(conn, 2, line_total="$1,249.95")
    _apply(conn)
    rows = conn.execute(
        "SELECT id, line_total, typeof(line_total) AS t FROM transaction_items ORDER BY id"
    ).fetchall()
    assert rows[0]["line_total"] == 249.95
    assert rows[0]["t"] == "real"
    assert rows[1]["line_total"] == 1249.95


def test_parses_dollar_strings_in_unit_price(conn):
    _seed(conn, 1, unit_price="$2.99/month")
    _seed(conn, 2, unit_price="$45.00")
    _apply(conn)
    rows = conn.execute(
        "SELECT id, unit_price FROM transaction_items ORDER BY id"
    ).fetchall()
    assert rows[0]["unit_price"] == 2.99
    assert rows[1]["unit_price"] == 45.0


def test_empty_strings_become_null(conn):
    _seed(conn, 1, line_total="", unit_price="", quantity="")
    _apply(conn)
    row = conn.execute(
        "SELECT line_total, unit_price, quantity FROM transaction_items WHERE id = 1"
    ).fetchone()
    assert row["line_total"] is None
    assert row["unit_price"] is None
    assert row["quantity"] is None


def test_numeric_real_values_unchanged(conn):
    _seed(conn, 1, line_total=49.95, unit_price=10.0, quantity=2)
    _apply(conn)
    row = conn.execute(
        "SELECT line_total, unit_price, quantity FROM transaction_items WHERE id = 1"
    ).fetchone()
    assert row["line_total"] == 49.95
    assert row["unit_price"] == 10.0
    assert row["quantity"] == 2


def test_null_values_unchanged(conn):
    _seed(conn, 1, line_total=None, unit_price=None, quantity=None)
    _apply(conn)
    row = conn.execute(
        "SELECT line_total, unit_price, quantity FROM transaction_items WHERE id = 1"
    ).fetchone()
    assert row["line_total"] is None
    assert row["unit_price"] is None
    assert row["quantity"] is None


def test_quantity_parses_integer_string(conn):
    _seed(conn, 1, quantity="2")
    _seed(conn, 2, quantity="10")
    _apply(conn)
    rows = conn.execute(
        "SELECT id, quantity FROM transaction_items ORDER BY id"
    ).fetchall()
    assert rows[0]["quantity"] == 2
    assert rows[1]["quantity"] == 10


def test_idempotent(conn):
    _seed(conn, 1, line_total="$19.95")
    _apply(conn)
    _apply(conn)  # second run must be a no-op
    row = conn.execute(
        "SELECT line_total FROM transaction_items WHERE id = 1"
    ).fetchone()
    assert row["line_total"] == 19.95
