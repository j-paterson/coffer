"""End-to-end: fetcher writes to DB, extract_pending finds the row.

These tests verify that IMAPFetcher and ManualFetcher actually populate
the emails table (via insert_email) so that extract_pending() can pick
them up.  We monkeypatch the `connect` context manager used by each
fetcher module to point at a temporary SQLite file with the real emails
schema applied.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pytest

from finance_pipeline.emails.fetchers.imap import IMAPFetcher, _IMAP4Error
from finance_pipeline.emails.fetchers.manual import ManualFetcher


# ---------------------------------------------------------------------------
# Shared fixture: fresh SQLite DB with the real emails schema
# ---------------------------------------------------------------------------

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "db" / "migrations"


def _apply_schema(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(path.read_text())
    conn.commit()
    conn.close()


@pytest.fixture
def email_db(monkeypatch, tmp_path):
    """Fresh on-disk SQLite DB with full schema.

    Monkeypatches the ``connect`` context manager that fetcher modules import
    from ``finance_pipeline.db`` so that all DB writes go to this test file.
    """
    db_path = tmp_path / "test.sqlite"
    _apply_schema(db_path)

    @contextmanager
    def _test_connect(db_path_arg: Path = db_path) -> Iterator[sqlite3.Connection]:
        # Always use the test DB regardless of the caller's db_path argument.
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA foreign_keys = ON")
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # Patch the connect used by each fetcher module
    import finance_pipeline.emails.fetchers.manual as manual_mod
    import finance_pipeline.emails.fetchers.imap as imap_mod
    monkeypatch.setattr(manual_mod, "connect", _test_connect)
    monkeypatch.setattr(imap_mod, "connect", _test_connect)

    return db_path


# ---------------------------------------------------------------------------
# ManualFetcher integration test
# ---------------------------------------------------------------------------

def test_manual_fetcher_populates_emails_table(email_db, tmp_path):
    """ManualFetcher.fetch_new() inserts a row per .eml so extract_pending can find it."""
    drop = tmp_path / "drop"
    drop.mkdir()
    eml = drop / "receipt.eml"
    eml.write_text(
        "From: store@example.com\r\n"
        "Subject: Your receipt\r\n"
        "Date: Wed, 01 May 2026 12:00:00 +0000\r\n"
        "\r\n"
        "body text"
    )

    fetcher = ManualFetcher(drop_directory=str(drop))
    paths = list(fetcher.fetch_new())
    assert len(paths) == 1

    conn = sqlite3.connect(email_db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, from_addr, subject, extraction_status FROM emails"
    ).fetchall()
    conn.close()

    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "manual-receipt"        # manual-<stem>
    assert "store@example.com" in row["from_addr"]
    assert row["subject"] == "Your receipt"
    assert row["extraction_status"] == "pending"


def test_manual_fetcher_idempotent_no_duplicate_rows(email_db, tmp_path):
    """Running fetch_new() twice on the same .eml must not duplicate DB rows
    (INSERT OR IGNORE guarantees this)."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "bill.eml").write_text(
        "From: vendor@example.com\r\n"
        "Subject: Invoice\r\n"
        "Date: Thu, 02 May 2026 08:00:00 +0000\r\n"
        "\r\n"
        "body"
    )

    fetcher = ManualFetcher(drop_directory=str(drop))
    list(fetcher.fetch_new())
    # Second run — state file not written yet (cli.py would call mark_processed),
    # so fetch_new yields again, but the DB INSERT OR IGNORE must swallow the dup.
    list(fetcher.fetch_new())

    conn = sqlite3.connect(email_db)
    count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
    conn.close()
    assert count == 1


# ---------------------------------------------------------------------------
# IMAPFetcher integration test (uses fake IMAP client)
# ---------------------------------------------------------------------------

class FakeIMAP:
    """Minimal stand-in for imaplib.IMAP4_SSL — mirrors test_email_fetchers_imap.py."""

    def __init__(self, host: str, port: int = 993) -> None:
        self.host = host
        self.port = port
        self.login_response: tuple[str, list] = ("OK", [b"Logged in"])
        self.search_response: tuple[str, list[bytes]] = ("OK", [b""])
        self.fetch_responses: dict[bytes, tuple[str, list]] = {}
        self.logged_out: bool = False

    def login(self, user: str, pw: str) -> tuple[str, list]:
        typ, data = self.login_response
        if typ != "OK":
            raise _IMAP4Error(f"Login failed: {data}")
        return (typ, data)

    def select(self, folder: str) -> tuple[str, list]:
        return ("OK", [b"1"])

    def uid(self, cmd: str, *args):
        if cmd == "SEARCH":
            return self.search_response
        if cmd == "FETCH":
            uid = args[0]
            return self.fetch_responses.get(uid, ("OK", []))
        if cmd == "STORE":
            return ("OK", [b""])
        raise ValueError(f"Unhandled IMAP UID command: {cmd!r}")

    def logout(self) -> tuple[str, list]:
        self.logged_out = True
        return ("BYE", [b"Logging out"])


def test_imap_fetcher_populates_emails_table(email_db, monkeypatch, tmp_path):
    """IMAPFetcher.fetch_new() inserts one row per fetched UNSEEN message."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)
    monkeypatch.setenv("IMAP_USERNAME", "user@example.com")
    monkeypatch.setenv("IMAP_PASSWORD", "secret")

    sample_eml = (
        b"From: shop@example.com\r\n"
        b"Subject: Order Confirmation\r\n"
        b"Date: Fri, 03 May 2026 10:00:00 +0000\r\n"
        b"\r\n"
        b"Your order is confirmed."
    )

    def factory(host: str, port: int = 993) -> FakeIMAP:
        inst = FakeIMAP(host, port)
        inst.search_response = ("OK", [b"55"])
        inst.fetch_responses = {
            b"55": ("OK", [(b"55 (RFC822 {N})", sample_eml), b")"]),
        }
        return inst

    monkeypatch.setattr("imaplib.IMAP4_SSL", factory)
    monkeypatch.setattr("imaplib.IMAP4", factory)

    fetcher = IMAPFetcher(
        host="imap.example.com",
        port=993,
        use_ssl=True,
        username_env="IMAP_USERNAME",
        password_env="IMAP_PASSWORD",
        folder="INBOX",
    )
    paths = list(fetcher.fetch_new())
    assert len(paths) == 1

    conn = sqlite3.connect(email_db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, from_addr, subject, extraction_status FROM emails"
    ).fetchall()
    conn.close()

    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "imap-55"
    assert "shop@example.com" in row["from_addr"]
    assert row["subject"] == "Order Confirmation"
    assert row["extraction_status"] == "pending"
