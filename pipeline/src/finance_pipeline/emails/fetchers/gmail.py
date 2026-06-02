"""Gmail OAuth fetcher.

Implements EmailFetcher for users with a Google Cloud OAuth client
credential. Caches .eml bodies under raw/email/YYYY-MM-DD/ keyed by
Gmail message id.

See docs/email.md for setup (credential creation + browser OAuth flow).
"""
from __future__ import annotations

import base64
import http.server
import os
import shutil
import sqlite3
import subprocess
import threading
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from ...config import GMAIL_CLIENT_SECRET, GMAIL_TOKEN, PROJECT_ROOT, RAW_EMAIL, SECRETS_DIR
from ...db import connect
from ..interfaces import EmailFetcher

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# Default receipt-ish query. We mix a broader subject net with explicit
# From-address rules for high-value senders whose receipts use inconsistent
# subject lines (notably Amazon, whose "Your Amazon.com order of..." doesn't
# contain any of the canonical receipt keywords).
DEFAULT_QUERY = (
    '('
    'subject:(receipt OR "order confirmation" OR "your order" OR '
    '"thanks for your order" OR "your trip" OR "trip receipt" OR '
    'reservation OR "booking confirmation" OR "payment received" OR '
    'invoice OR subscription OR "has shipped" OR "your purchase")'
    ' OR from:auto-confirm@amazon.com'
    ' OR from:order-update@amazon.com'
    ' OR from:shipment-tracking@amazon.com'
    ' OR from:digital-no-reply@amazon.com'
    ' OR from:no_reply@email.apple.com'
    ' OR from:noreply@uber.com'
    ' OR from:no-reply@lyftmail.com'
    ' OR from:express@customer.costco.com'
    ')'
)


@dataclass
class FetchStats:
    searched: int = 0
    new: int = 0
    skipped_existing: int = 0
    errors: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "searched": self.searched,
            "new": self.new,
            "skipped_existing": self.skipped_existing,
            "errors": self.errors,
        }


def _load_credentials() -> Credentials:
    if not GMAIL_CLIENT_SECRET.exists():
        raise SystemExit(
            "Gmail OAuth client credential missing at .secrets/gmail_client.json. "
            "Receipt extraction needs a Google Cloud OAuth client. "
            "See docs/email.md for how to create one."
        )

    SECRETS_DIR.mkdir(parents=True, exist_ok=True)

    creds: Credentials | None = None
    if GMAIL_TOKEN.exists():
        creds = Credentials.from_authorized_user_file(str(GMAIL_TOKEN), SCOPES)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        flow = InstalledAppFlow.from_client_secrets_file(
            str(GMAIL_CLIENT_SECRET), SCOPES
        )
        creds = _run_oauth_flow(flow)

    GMAIL_TOKEN.write_text(creds.to_json())
    GMAIL_TOKEN.chmod(0o600)
    return creds


def _is_wsl() -> bool:
    return "microsoft" in os.uname().release.lower()


def _open_browser(url: str) -> bool:
    """Best-effort browser launch across platforms. Returns True on success."""
    if _is_wsl():
        # explorer.exe handles URLs without mangling `&` the way cmd.exe does.
        # It exits non-zero on success, so we don't check the return code.
        try:
            subprocess.Popen(
                ["explorer.exe", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except FileNotFoundError:
            pass
    # Generic fallbacks
    for cmd in ("xdg-open", "open"):
        if shutil.which(cmd):
            try:
                subprocess.Popen(
                    [cmd, url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return True
            except Exception:
                continue
    return False


def _copy_to_clipboard(text: str) -> bool:
    """Best-effort clipboard copy. Returns True on success."""
    if _is_wsl() and shutil.which("clip.exe"):
        try:
            subprocess.run(
                ["clip.exe"], input=text.encode("utf-8"), check=True
            )
            return True
        except Exception:
            return False
    return False


def _run_oauth_flow(flow: InstalledAppFlow, port: int = 8765) -> Credentials:
    """Run the installed-app OAuth flow.

    Implemented manually (rather than flow.run_local_server) so we can print
    the full authorization URL — including a stable state token — before
    blocking on the redirect, and so we can auto-launch the Windows browser
    from WSL. The local loopback server catches the redirect.
    """
    flow.redirect_uri = f"http://localhost:{port}/"
    auth_url, state = flow.authorization_url(
        prompt="consent", access_type="offline"
    )
    launched = _open_browser(auth_url)
    copied = _copy_to_clipboard(auth_url)
    if launched:
        print("\nA browser tab has been opened for Gmail authorization.")
    else:
        print("\nOpen this URL in your browser to authorize Gmail access:")
        print(f"\n  {auth_url}\n")
    if copied:
        print("(URL also copied to your clipboard.)")
    print(f"Waiting for redirect on localhost:{port}...\n", flush=True)

    result: dict[str, str] = {}

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result.update({k: v[0] for k, v in params.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<h1>Auth complete.</h1><p>You can close this tab.</p>"
            )

        def log_message(self, *args, **kwargs):  # silence default access log
            pass

    server = http.server.HTTPServer(("localhost", port), _Handler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    thread.join(timeout=600)
    server.server_close()

    if "error" in result:
        raise RuntimeError(f"OAuth error: {result['error']}")
    if "code" not in result:
        raise RuntimeError("OAuth flow timed out waiting for redirect")
    if result.get("state") != state:
        raise RuntimeError("OAuth state mismatch (possible CSRF)")

    flow.fetch_token(code=result["code"])
    return flow.credentials


def _gmail_service():
    return build("gmail", "v1", credentials=_load_credentials(), cache_discovery=False)


def _parse_internal_date(ms: str) -> datetime:
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)


def _header(headers: list[dict], name: str) -> str:
    lname = name.lower()
    for h in headers:
        if h.get("name", "").lower() == lname:
            return h.get("value", "")
    return ""


def _eml_path(msg_id: str, received_at: datetime) -> Path:
    day = received_at.strftime("%Y-%m-%d")
    return RAW_EMAIL / day / f"{msg_id}.eml"


def _write_raw(service, msg_id: str, path: Path) -> None:
    raw_msg = (
        service.users()
        .messages()
        .get(userId="me", id=msg_id, format="raw")
        .execute()
    )
    data = base64.urlsafe_b64decode(raw_msg["raw"].encode("ascii"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _existing_ids(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT id FROM emails")}


def _insert_email(
    conn: sqlite3.Connection,
    msg_id: str,
    received_at: datetime,
    from_addr: str,
    subject: str,
    raw_path: Path,
) -> None:
    conn.execute(
        """
        INSERT INTO emails (id, received_at, from_addr, subject, raw_path)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            msg_id,
            received_at.isoformat(),
            from_addr,
            subject,
            str(raw_path.relative_to(PROJECT_ROOT)),
        ),
    )


def print_report(stats: FetchStats) -> None:
    print(
        f"searched {stats.searched}  new {stats.new}  "
        f"skipped {stats.skipped_existing}  errors {stats.errors}"
    )


class GmailFetcher(EmailFetcher):
    """Wraps the Gmail OAuth fetch loop into the EmailFetcher contract.

    fetch_new() runs sync() and yields the .eml Path for every newly-cached
    message. mark_processed() is a no-op for Gmail — the fetcher tracks state
    via the emails DB table's extraction_status column, which extract.py owns.
    """

    def __init__(self, max_results: int = 100, query: str | None = None) -> None:
        self.max_results = max_results
        self.query = query if query is not None else DEFAULT_QUERY
        self.stats: FetchStats = FetchStats()

    def fetch_new(self) -> Iterator[Path]:
        """Run the Gmail sync and yield .eml paths for every newly-fetched message."""
        self.stats = FetchStats()
        service = _gmail_service()

        try:
            resp = (
                service.users()
                .messages()
                .list(userId="me", q=self.query, maxResults=self.max_results)
                .execute()
            )
        except HttpError as e:
            raise RuntimeError(f"Gmail list failed: {e}") from e

        messages = resp.get("messages", [])
        self.stats.searched = len(messages)
        if not messages:
            return

        with connect() as conn:
            existing = _existing_ids(conn)
            for m in messages:
                msg_id = m["id"]
                if msg_id in existing:
                    self.stats.skipped_existing += 1
                    continue
                try:
                    meta = (
                        service.users()
                        .messages()
                        .get(
                            userId="me",
                            id=msg_id,
                            format="metadata",
                            metadataHeaders=["From", "Subject", "Date"],
                        )
                        .execute()
                    )
                except HttpError as e:
                    self.stats.errors += 1
                    print(f"  warn: metadata fetch failed for {msg_id}: {e}")
                    continue

                headers = meta.get("payload", {}).get("headers", [])
                received_at = _parse_internal_date(meta["internalDate"])
                from_addr = _header(headers, "From")
                subject = _header(headers, "Subject") or "(no subject)"

                raw_path = _eml_path(msg_id, received_at)
                try:
                    if not raw_path.exists():
                        _write_raw(service, msg_id, raw_path)
                except HttpError as e:
                    self.stats.errors += 1
                    print(f"  warn: raw fetch failed for {msg_id}: {e}")
                    continue

                _insert_email(conn, msg_id, received_at, from_addr, subject, raw_path)
                self.stats.new += 1
                yield raw_path

    def mark_processed(self, email_id: str) -> None:
        """No-op: Gmail fetch state is tracked via the emails DB table.

        The extraction_status column (managed by extract.py) serves as the
        processed marker. Nothing to write here at fetch time.
        """
