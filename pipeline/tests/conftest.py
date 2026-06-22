"""Shared pytest fixtures: in-memory SQLite DB pre-loaded with the v2 schema.

Each test gets a fresh DB with the same migrations the production
schema has, so tests exercise the actual constraints (FKs, UNIQUEs,
defaults) rather than a stripped-down copy."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "db" / "migrations"


def _load_schema(conn: sqlite3.Connection) -> None:
    """Apply every .sql migration in order."""
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(path.read_text())


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory DB with full v2 schema applied."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    _load_schema(c)
    yield c
    c.close()


@pytest.fixture
def seed_txn(conn: sqlite3.Connection):
    """Factory that inserts a transactions_v2 row + postings + one
    synthesized item. Mirrors migration 043's synthesis shape: every
    txn has at least one item; line_total is the sum of non-equity
    postings.

    `postings` is a list of (account_id, amount) tuples — typically one
    real-account leg and one equity counterparty. Returns the txn id.
    """
    def _insert(
        *,
        date: str,
        description: str,
        postings: list[tuple[str, float]],
        item_category: str | None = None,
    ) -> int:
        # postings.account_id FKs accounts.id — ensure each referenced account
        # row exists before inserting the leg. Equity accounts use type='equity'.
        for account_id, _ in postings:
            is_equity = account_id.startswith("equity:")
            conn.execute(
                """
                INSERT OR IGNORE INTO accounts
                  (id, display_name, institution, type, currency, active, mode)
                VALUES (?, ?, ?, ?, 'USD', 1, 'live')
                """,
                (
                    account_id,
                    account_id,
                    "test",
                    "equity" if is_equity else "checking",
                ),
            )
        cur = conn.execute(
            "INSERT INTO transactions_v2 (date, description, derived_by) "
            "VALUES (?, ?, 'test')",
            (date, description),
        )
        tid = cur.lastrowid
        for account_id, amount in postings:
            conn.execute(
                "INSERT INTO postings (txn_id, account_id, amount) "
                "VALUES (?, ?, ?)",
                (tid, account_id, amount),
            )
        non_equity = sum(
            a for acc, a in postings if not acc.startswith("equity:")
        )
        conn.execute(
            "INSERT INTO transaction_items "
            "(line_no, name, line_total, category, transaction_v2_id) "
            "VALUES (1, ?, ?, ?, ?)",
            (description, non_equity, item_category, tid),
        )
        conn.commit()
        return tid
    return _insert


@pytest.fixture
def seed_account(conn: sqlite3.Connection):
    """Helper to insert an account row. Returns the id."""
    def _insert(
        id: str,
        display_name: str = "Test Account",
        type: str = "checking",
        active: int = 1,
        merged_into: str | None = None,
        institution: str = "Test Bank",
        mode: str = "live",
    ) -> str:
        conn.execute(
            """
            INSERT INTO accounts
              (id, display_name, institution, type, currency, active, mode, merged_into)
            VALUES (?, ?, ?, ?, 'USD', ?, ?, ?)
            """,
            (id, display_name, institution, type, active, mode, merged_into),
        )
        return id
    return _insert
