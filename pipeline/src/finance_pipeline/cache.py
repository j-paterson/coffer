"""Thin wrapper over the ``provider_cache`` table.

Lets sync/backfill modules record "when did we last successfully fetch
this subject from this source?" so re-runs within a short TTL skip the
work instead of re-hitting a rate-limited upstream.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from . import db


def was_fetched_within(source: str, subject: str, hours: int = 24) -> bool:
    """True if we've cached a successful fetch of (source, subject)
    within the last `hours`. Opens its own connection — fine for the
    few-dozen calls the backfills make per run."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT fetched_at FROM provider_cache WHERE source=? AND subject=?",
            (source, subject),
        ).fetchone()
    if not row:
        return False
    # SQLite CURRENT_TIMESTAMP returns 'YYYY-MM-DD HH:MM:SS' in UTC.
    try:
        fetched = datetime.fromisoformat(str(row[0]).replace(" ", "T"))
    except ValueError:
        return False
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    return datetime.now(tz=timezone.utc) - fetched < timedelta(hours=hours)


def mark_fetched(conn: sqlite3.Connection, source: str, subject: str) -> None:
    """Record a successful fetch on an already-open connection. Caller
    commits when they're done."""
    conn.execute(
        """
        INSERT INTO provider_cache (source, subject, fetched_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source, subject) DO UPDATE SET
          fetched_at = CURRENT_TIMESTAMP
        """,
        (source, subject),
    )
