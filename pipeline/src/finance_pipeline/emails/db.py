"""Shared DB and .eml-parsing helpers for email fetchers."""
from __future__ import annotations

import email as stdlib_email
import email.policy
import email.utils
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def insert_email(
    conn: sqlite3.Connection,
    msg_id: str,
    received_at: datetime,
    from_addr: str,
    subject: str,
    raw_path: Path,
) -> None:
    """Insert one email row (id already in DB is silently ignored).

    Mirrors the schema used by GmailFetcher: raw_path is stored as a
    project-relative string (relative to PROJECT_ROOT).  Callers must
    already have made it relative before passing it in, or pass the
    absolute path and let this function relativise it when PROJECT_ROOT
    is available.

    For IMAP and Manual fetchers the raw_path *is* the full absolute path;
    we store it as-is so extract_pending can reconstruct it via
    ``PROJECT_ROOT / row["raw_path"]``.  To be consistent with the Gmail
    convention we try to make it relative to PROJECT_ROOT, but fall back to
    the absolute string when that is not possible (e.g. in tests that use
    tmp_path outside the project tree).
    """
    from ..config import PROJECT_ROOT

    try:
        stored_path = str(raw_path.relative_to(PROJECT_ROOT))
    except ValueError:
        stored_path = str(raw_path)

    conn.execute(
        """
        INSERT OR IGNORE INTO emails (id, received_at, from_addr, subject, raw_path)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            msg_id,
            received_at.isoformat(),
            from_addr,
            subject,
            stored_path,
        ),
    )


def parse_eml_meta(eml_path: Path) -> tuple[str, str, datetime]:
    """Extract (from_addr, subject, received_at) from a raw .eml file.

    Falls back gracefully when headers are missing or the Date header
    cannot be parsed.
    """
    with eml_path.open("rb") as f:
        msg = stdlib_email.message_from_binary_file(f, policy=stdlib_email.policy.default)
    from_addr: str = msg.get("From", "") or ""
    subject: str = msg.get("Subject", "") or "(no subject)"
    date_str: str = msg.get("Date", "") or ""
    try:
        received_at = email.utils.parsedate_to_datetime(date_str)
    except (TypeError, ValueError):
        received_at = datetime.now(timezone.utc)
    return from_addr, subject, received_at
