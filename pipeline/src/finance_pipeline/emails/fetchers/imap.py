"""IMAP4 fetcher.

Implements EmailFetcher for users with any IMAP-capable mail server
(Fastmail, ProtonMail Bridge, on-prem Dovecot, etc.). Uses stdlib
imaplib — no new optional deps. Authenticates via username/password
from configured env vars.

See docs/email.md for setup.
"""
from __future__ import annotations

import imaplib
import os
from pathlib import Path
from typing import Iterator

from ..interfaces import EmailFetcher
from ...config import RAW_EMAIL

# Capture the real error class at import time so tests that monkeypatch
# imaplib.IMAP4 with a factory function don't break the `except` clauses.
_IMAP4Error = imaplib.IMAP4.error


class IMAPFetcher(EmailFetcher):
    """Fetches unseen IMAP messages and caches them as .eml files.

    Each call to fetch_new() opens a fresh connection, searches for UNSEEN
    messages, fetches their full RFC822 bodies, writes them to
    raw/email/imap-<uid>.eml, and yields the Path.

    mark_processed() sets the \\Seen flag on the server via a separate
    connection (opened lazily and reused across calls).
    """

    def __init__(
        self,
        host: str,
        port: int = 993,
        use_ssl: bool = True,
        username_env: str = "IMAP_USERNAME",
        password_env: str = "IMAP_PASSWORD",
        folder: str = "INBOX",
    ) -> None:
        self.host = host
        self.port = port
        self.use_ssl = use_ssl
        self.username_env = username_env
        self.password_env = password_env
        self.folder = folder
        # Lazy connection used by mark_processed — kept open between calls
        self._mark_conn: imaplib.IMAP4 | None = None

    def _resolve_credentials(self) -> tuple[str, str]:
        """Read username/password from env vars; raise SystemExit if missing."""
        username = os.environ.get(self.username_env)
        password = os.environ.get(self.password_env)
        if not username or not password:
            raise SystemExit(
                f"IMAP credentials not set: ${self.username_env} and/or "
                f"${self.password_env}. See docs/email.md for setup."
            )
        return username, password

    def _open_connection(self) -> imaplib.IMAP4:
        """Open, authenticate, and select the configured folder."""
        username, password = self._resolve_credentials()
        try:
            if self.use_ssl:
                conn = imaplib.IMAP4_SSL(self.host, self.port)
            else:
                conn = imaplib.IMAP4(self.host, self.port)
            typ, _ = conn.login(username, password)
            if typ != "OK":
                raise _IMAP4Error(f"Login returned {typ}")
            conn.select(self.folder)
        except _IMAP4Error as e:
            raise SystemExit(
                f"IMAP connection failed ({self.host}:{self.port}): {e}. "
                f"See docs/email.md for setup."
            )
        return conn

    def fetch_new(self) -> Iterator[Path]:
        """Connect, search UNSEEN, cache each message, yield its Path."""
        conn = self._open_connection()
        try:
            typ, data = conn.uid("SEARCH", None, "UNSEEN")
            if typ != "OK":
                raise SystemExit(
                    f"IMAP SEARCH failed: {data}. See docs/email.md."
                )

            raw_uids: bytes = data[0] if data and data[0] else b""
            uids = raw_uids.split() if raw_uids else []

            for uid in uids:
                try:
                    typ, msg_data = conn.uid("FETCH", uid, "(RFC822)")
                except _IMAP4Error as e:
                    raise SystemExit(
                        f"IMAP FETCH failed for UID {uid!r}: {e}. "
                        f"See docs/email.md."
                    )
                if typ != "OK" or not msg_data:
                    continue

                # msg_data is typically [(b'<descr>', raw_bytes), b')']
                raw_bytes: bytes | None = None
                for part in msg_data:
                    if isinstance(part, tuple) and len(part) == 2:
                        raw_bytes = part[1]
                        break
                if raw_bytes is None:
                    continue

                RAW_EMAIL.mkdir(parents=True, exist_ok=True)
                uid_str = uid.decode("ascii") if isinstance(uid, bytes) else str(uid)
                eml_path = RAW_EMAIL / f"imap-{uid_str}.eml"
                eml_path.write_bytes(raw_bytes)
                yield eml_path
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    def mark_processed(self, email_id: str) -> None:
        """Set the \\Seen flag on the server for the given UID.

        Idempotent — IMAP servers don't error if the message is already Seen.
        """
        if self._mark_conn is None:
            self._mark_conn = self._open_connection()
        try:
            self._mark_conn.uid(
                "STORE",
                email_id.encode("ascii"),
                "+FLAGS",
                "(\\Seen)",
            )
        except _IMAP4Error as e:
            raise SystemExit(
                f"IMAP STORE failed for UID {email_id!r}: {e}. "
                f"See docs/email.md."
            )
