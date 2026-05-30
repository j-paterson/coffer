"""NuExtract-powered receipt extractor for milestone 8b.

Drains the `emails` table's `extraction_status='pending'` queue:

  1. Parse the cached .eml file and pull out a plain-text body.
  2. Feed the body to NuExtract (Ollama HTTP API) with a receipt template.
  3. Normalize the extracted fields (parse amounts, parse dates).
  4. Update the email row and insert any line items into transaction_items.

Absolutely no hallucination path: NuExtract is extractive by construction.
Fields NuExtract leaves blank stay blank in the DB.
"""
from __future__ import annotations

import email as stdlib_email
import json
import re
import sqlite3
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import default as email_default_policy
from pathlib import Path

from bs4 import BeautifulSoup

from ..config import PROJECT_ROOT
from ..db import connect
from . import amazon as amazon_parser
from . import senders
from . import teamwork as teamwork_parser
from . import venmo as venmo_parser

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "nuextract:3.8b"

# Template mirrors the Phase A validation template. Fields left blank by
# NuExtract on a given receipt remain blank — that's the extractive contract.
TEMPLATE: dict = {
    "merchant": "",
    "date": "",
    "currency": "",
    "subtotal": "",
    "tax": "",
    "total": "",
    "payment_method": "",
    "order_id": "",
    "items": [
        {
            "name": "",
            "quantity": "",
            "unit_price": "",
            "line_total": "",
        }
    ],
}


@dataclass
class ExtractStats:
    processed: int = 0
    extracted: int = 0
    failed: int = 0
    skipped: int = 0
    amazon_parsed: int = 0
    nuextract_calls: int = 0
    items_written: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "processed": self.processed,
            "extracted": self.extracted,
            "failed": self.failed,
            "skipped": self.skipped,
            "amazon_parsed": self.amazon_parsed,
            "nuextract_calls": self.nuextract_calls,
            "items_written": self.items_written,
        }


# --- .eml parsing -----------------------------------------------------------


@dataclass
class EmailBody:
    from_addr: str
    subject: str
    text: str


def _parse_eml(path: Path) -> EmailBody:
    with path.open("rb") as fh:
        msg: EmailMessage = stdlib_email.message_from_binary_file(
            fh, policy=email_default_policy
        )  # type: ignore[assignment]

    from_addr = msg.get("From", "") or ""
    subject = msg.get("Subject", "") or ""

    # Prefer text/plain when substantive — many senders (Amazon, etc.) put
    # cleaner item data there than in marketing-heavy HTML. But Square-class
    # senders ship a stub text/plain alternative ("you received an invoice,
    # pay at <link>") next to the real HTML item table; those we fall through
    # to the HTML body. 500 chars cleanly separates real plaintext bodies
    # (observed min ~940) from invoice-summary stubs (observed ~190).
    plain_part = msg.get_body(preferencelist=("plain",))
    html_part = msg.get_body(preferencelist=("html",))
    plain_raw = plain_part.get_content() if plain_part else ""
    html_raw = html_part.get_content() if html_part else ""
    _PLAIN_STUB_THRESHOLD = 500
    if len(plain_raw.strip()) >= _PLAIN_STUB_THRESHOLD:
        content = plain_raw
    elif html_raw.strip():
        content = html_raw
    else:
        content = plain_raw
    # Always run through the HTML stripper — some senders (Eventbrite)
    # embed literal tags inside their text/plain alternative.
    content = _html_to_text(content)
    return EmailBody(from_addr, subject, _squeeze_whitespace(content))


def _html_to_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    # Drop noise tags that confuse the extractor.
    for tag in soup(["script", "style", "noscript", "head", "meta", "link"]):
        tag.decompose()
    # Table-aware pass: flatten LEAF tables (tables with no nested <table>
    # children) to pipe-separated rows so cell boundaries survive for
    # NuExtract. Must run BEFORE the generic block-tag newline injection.
    #
    # Using only leaf tables avoids the quadratic text explosion that occurs
    # when processing outer layout tables in deeply-nested layouts (e.g. Square
    # and Lyft emails can have 25–127 nested tables where each outer-table row
    # includes the entire email content). Leaf tables are the innermost data
    # tables; their pipe-separated text is embedded into parent cells and then
    # picked up naturally by the block-tag get_text() pass below.
    for table in soup.find_all("table"):
        if table.find("table"):
            continue  # not a leaf — skip; inner tables will be handled first
        rows: list[str] = []
        for tr in table.find_all("tr"):
            cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if any(c for c in cells):
                rows.append(" | ".join(cells))
        if rows:
            table.replace_with("\n\n" + "\n".join(rows) + "\n\n")
    # Inject newlines around block elements so layout survives .get_text().
    # Keep tr/td here so any non-leaf parent tables (still in the DOM after
    # their leaf children were replaced with text) render with line breaks.
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for tag in soup.find_all(["p", "div", "tr", "td", "li", "h1", "h2", "h3"]):
        tag.append("\n")
    return soup.get_text()


_WS_RE = re.compile(r"[ \t]+")
_BLANK_RE = re.compile(r"\n\s*\n+")


def _squeeze_whitespace(text: str) -> str:
    text = _WS_RE.sub(" ", text)
    text = _BLANK_RE.sub("\n\n", text)
    return text.strip()


# --- NuExtract call ---------------------------------------------------------


def _build_prompt(body: EmailBody, matched_amount: float | None = None) -> str:
    tmpl = json.dumps(TEMPLATE, indent=2)
    # Prepend From/Subject/Total so NuExtract anchors on the sender and the
    # known total. NuExtract is extractive — adding these lines to the text
    # lets it use them as normal extractable tokens (it can't invent them).
    parts = [f"From: {body.from_addr}", f"Subject: {body.subject}"]
    if matched_amount is not None:
        parts.append(f"Total paid: ${matched_amount:.2f}")
    preamble = "\n".join(parts) + "\n\n"
    text = (preamble + body.text)[:12000]
    return f"<|input|>\n### Template:\n{tmpl}\n### Text:\n{text}\n<|output|>\n"


# Narrower template used by the retry pass when the main extraction comes
# back with an empty items array on a body that clearly has itemized content.
ITEMS_TEMPLATE: dict = {
    "items": [
        {
            "name": "",
            "quantity": "",
            "unit_price": "",
            "line_total": "",
        }
    ],
}


def _build_items_prompt(body: EmailBody, matched_amount: float | None = None) -> str:
    tmpl = json.dumps(ITEMS_TEMPLATE, indent=2)
    parts = [f"From: {body.from_addr}", f"Subject: {body.subject}"]
    if matched_amount is not None:
        parts.append(f"Total paid: ${matched_amount:.2f}")
    preamble = "\n".join(parts) + "\n\n"
    text = (preamble + body.text)[:12000]
    return f"<|input|>\n### Template:\n{tmpl}\n### Text:\n{text}\n<|output|>\n"


def _call_nuextract(prompt: str, timeout: float = 180.0) -> tuple[str, float]:
    payload = json.dumps(
        {
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return data.get("response", ""), time.time() - t0


def _clean_output(raw: str) -> str:
    return raw.replace("<|end-output|>", "").strip()


# --- field normalization ----------------------------------------------------


# Matches a single dollar amount; anchored to stop at the number so trailing
# "/month" or "USD" or parenthetical notes don't bleed into the capture. The
# comma-grouped branch requires at least one comma so plain "7800" doesn't
# truncate to "780".
_AMOUNT_RE = re.compile(
    r"-?\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
)
_DATE_FORMATS = [
    "%Y-%m-%d",
    "%b %d %Y",
    "%B %d %Y",
    "%d %b %Y",
    "%d %B %Y",
    "%m/%d/%Y",
    "%m/%d/%y",
]


def _parse_amount(raw: str | None) -> float | None:
    if not raw:
        return None
    m = _AMOUNT_RE.search(raw)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _parse_int(raw: str | None) -> float | None:
    if not raw:
        return None
    m = re.search(r"\d+(?:\.\d+)?", raw)
    return float(m.group(0)) if m else None


_DATE_MONTH_FIRST_RE = re.compile(r"([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})")
_DATE_DAY_FIRST_RE = re.compile(r"\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b")


def _parse_date(raw: str | None) -> str | None:
    """Pull an ISO date from messy NuExtract output.

    Handles "Apr 5, 2026, 6:11:40 PM" and "Wed, 04 Mar 2026 13:28:43 +0000"
    and "April 10, 2026" by first hunting for a "MonthName Day Year" anchor,
    then falling back to known strptime formats.
    """
    if not raw:
        return None
    # Month-first: "Apr 5, 2026, 6:11:40 PM" / "April 10, 2026"
    m = _DATE_MONTH_FIRST_RE.search(raw)
    if m:
        candidate = f"{m.group(1)} {m.group(2)} {m.group(3)}"
        for fmt in ("%b %d %Y", "%B %d %Y"):
            try:
                return datetime.strptime(candidate, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    # Day-first: "Wed, 4 Mar 2026 13:28:43 +0000"
    m = _DATE_DAY_FIRST_RE.search(raw)
    if m:
        candidate = f"{m.group(1)} {m.group(2)} {m.group(3)}"
        for fmt in ("%d %b %Y", "%d %B %Y"):
            try:
                return datetime.strptime(candidate, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    # Already-ISO date anywhere in the string.
    m2 = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", raw)
    if m2:
        return m2.group(0)
    # Third: numeric formats like 4/10/2026
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# --- DB I/O -----------------------------------------------------------------


def _load_pending(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT id, raw_path, received_at, from_addr, subject
        FROM emails
        WHERE extraction_status = 'pending'
        ORDER BY received_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return list(rows)


def _mark_failed(conn: sqlite3.Connection, email_id: str, reason: str) -> None:
    conn.execute(
        """
        UPDATE emails
        SET extraction_status = 'failed',
            extracted_at = ?,
            raw_extraction = ?
        WHERE id = ?
        """,
        (datetime.now(timezone.utc).isoformat(), reason, email_id),
    )


def _mark_skipped(conn: sqlite3.Connection, email_id: str, reason: str) -> None:
    conn.execute(
        """
        UPDATE emails
        SET extraction_status = 'skipped',
            match_status = 'none',
            extracted_at = ?,
            raw_extraction = ?
        WHERE id = ?
        """,
        (datetime.now(timezone.utc).isoformat(), reason, email_id),
    )


# ---------- match-first prefilter -----------------------------------------

# Dollar amount regexes. We accept two forms:
#   1. $-prefixed: "$34.94", "$1,234.56" — the dominant US format
#   2. USD-suffixed: "80.06 USD" — used by Amazon and a few others that
#      strip currency symbols from their plaintext
# Both require at least one decimal digit so we don't catch order IDs.
_BODY_DOLLAR_RE = re.compile(r"\$\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})")
_BODY_USD_RE = re.compile(
    r"(\d{1,3}(?:,\d{3})*\.\d{1,2}|\d+\.\d{1,2})\s*USD\b",
    re.IGNORECASE,
)

# Tolerances mirror the strict-pass matcher in emails/match.py but with a
# wider date window because snippets don't always reflect the exact txn day.
PREFILTER_AMOUNT_DELTA = 0.05
PREFILTER_DATE_WINDOW = 7


def _extract_amounts(text: str) -> set[float]:
    amounts: set[float] = set()
    for regex in (_BODY_DOLLAR_RE, _BODY_USD_RE):
        for m in regex.finditer(text):
            try:
                amounts.add(float(m.group(1).replace(",", "")))
            except ValueError:
                continue
    # Drop the $0.00 placeholder — it will match freebies but not the kind
    # of thing we're trying to enrich.
    amounts.discard(0.0)
    return amounts


def _has_txn_candidate(
    conn: sqlite3.Connection,
    amounts: set[float],
    received_at: datetime,
) -> float | None:
    """Return the first amount that has a plausible transaction match."""
    if not amounts:
        return None
    lo_date = (received_at.date() - timedelta(days=PREFILTER_DATE_WINDOW)).isoformat()
    hi_date = (received_at.date() + timedelta(days=PREFILTER_DATE_WINDOW)).isoformat()
    for amt in sorted(amounts, reverse=True):  # try largest first — usually the total
        hit = conn.execute(
            """
            SELECT 1
            FROM transactions_v2 t
            JOIN postings p ON p.txn_id = t.id
            WHERE t.date BETWEEN ? AND ?
              AND p.account_id NOT LIKE 'equity:%'
              AND ABS(ABS(p.amount) - ?) <= ?
            LIMIT 1
            """,
            (lo_date, hi_date, amt, PREFILTER_AMOUNT_DELTA),
        ).fetchone()
        if hit:
            return amt
    return None


def _write_extraction(
    conn: sqlite3.Connection,
    email_id: str,
    parsed: dict,
    raw_json: str,
) -> int:
    """Update the email row; insert line items. Returns items written."""
    conn.execute(
        """
        UPDATE emails
        SET merchant = ?,
            receipt_date = ?,
            total_usd = ?,
            currency = ?,
            order_id = ?,
            payment_hint = ?,
            extraction_status = 'extracted',
            extraction_model = ?,
            extracted_at = ?,
            raw_extraction = ?
        WHERE id = ?
        """,
        (
            parsed.get("merchant") or None,
            _parse_date(parsed.get("date")),
            _parse_amount(parsed.get("total")),
            (parsed.get("currency") or "").upper() or None,
            parsed.get("order_id") or None,
            parsed.get("payment_method") or None,
            MODEL,
            datetime.now(timezone.utc).isoformat(),
            raw_json,
            email_id,
        ),
    )

    items = parsed.get("items") or []
    if not isinstance(items, list):
        items = []
    # Carry over any already-matched transaction_v2_id so re-extractions on
    # previously-matched emails produce items visible to the v2-join UIs,
    # instead of orphaned items that wait for a match refresh.
    known_v2_id = conn.execute(
        "SELECT transaction_v2_id FROM emails WHERE id = ?", (email_id,)
    ).fetchone()
    txn_v2_id = known_v2_id[0] if known_v2_id else None

    # Dedupe. Square-style senders ship multiple emails per invoice
    # (invoice-created, reminder, payment-initiated, payment-processed)
    # and each passes match-email onto the same ACH transaction. Running
    # extract on all of them inserts the same line items 3-6× over,
    # inflating the bundle's itemized-cost view.
    #
    # Strategy: one canonical email per (transaction_v2_id). If another
    # email already owns the items and its data is at least as good as
    # ours (non-NULL line_total count is the quality signal — reminder
    # emails often lose the per-line prices), skip. If ours is strictly
    # better, replace. Tie → keep existing (stable).
    new_quality = sum(
        1 for it in items if isinstance(it, dict) and _parse_amount(it.get("line_total")) is not None
    )
    if txn_v2_id is not None:
        existing = conn.execute(
            """
            SELECT email_id, COUNT(*) AS n, SUM(line_total IS NOT NULL) AS non_null
            FROM transaction_items
            WHERE transaction_v2_id = ? AND email_id != ?
            GROUP BY email_id
            ORDER BY non_null DESC, n DESC
            LIMIT 1
            """,
            (txn_v2_id, email_id),
        ).fetchone()
        if existing is not None:
            existing_quality = existing[2] or 0
            if new_quality > existing_quality:
                # We beat the incumbent — evict its items, then ours go in.
                conn.execute(
                    "DELETE FROM transaction_items WHERE transaction_v2_id = ? AND email_id = ?",
                    (txn_v2_id, existing[0]),
                )
            else:
                return 0
    written = 0
    for i, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip()
        if not name:
            continue
        conn.execute(
            """
            INSERT INTO transaction_items
                (email_id, transaction_v2_id, line_no, name, quantity, unit_price, line_total, raw)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                email_id,
                txn_v2_id,
                i,
                name,
                _parse_int(item.get("quantity")),
                _parse_amount(item.get("unit_price")),
                _parse_amount(item.get("line_total")),
                json.dumps(item),
            ),
        )
        written += 1
    return written


# --- public API -------------------------------------------------------------


def extract_pending(limit: int = 50) -> ExtractStats:
    stats = ExtractStats()
    with connect() as conn:
        # Make sure the seed senders are in the profile table. Cheap no-op
        # after the first run.
        senders.seed_if_empty(conn)

        pending = _load_pending(conn, limit)
        if not pending:
            return stats
        for row in pending:
            stats.processed += 1
            eml_path = PROJECT_ROOT / row["raw_path"]
            if not eml_path.exists():
                _mark_failed(conn, row["id"], f"missing eml file: {eml_path}")
                stats.failed += 1
                continue
            try:
                body = _parse_eml(eml_path)
            except Exception as e:
                _mark_failed(conn, row["id"], f"eml parse error: {e}")
                stats.failed += 1
                continue
            if not body.text:
                _mark_failed(conn, row["id"], "empty body")
                stats.failed += 1
                continue

            # Sender routing — check if we already know what to do with this
            # sender (subscription/noise → skip, amazon → dedicated parser).
            sender_type = senders.lookup(conn, row["from_addr"])
            if sender_type in {"subscription", "noise"}:
                _mark_skipped(conn, row["id"], f"sender profile: {sender_type}")
                stats.skipped += 1
                conn.commit()
                continue

            # Match-first prefilter: if no dollar amount in the body has a
            # plausible transaction candidate within the window, don't bother
            # running NuExtract. See PROCESS.md milestone 8b.1 for context.
            amounts = _extract_amounts(body.text)
            received = datetime.fromisoformat(row["received_at"])
            candidate = _has_txn_candidate(conn, amounts, received)
            if candidate is None:
                reason = (
                    f"no candidate: {len(amounts)} amounts, none match a txn "
                    f"within ±{PREFILTER_DATE_WINDOW}d"
                )
                _mark_skipped(conn, row["id"], reason)
                stats.skipped += 1
                conn.commit()
                continue

            # Venmo fast path: parse payment confirmation from subject + HTML body.
            # Routed by from_addr check (not sender_profiles type) because the
            # migration 008 CHECK constraint predates the venmo type.
            is_venmo = "venmo@venmo.com" in (row["from_addr"] or "").lower()
            if is_venmo and venmo_parser.is_venmo_payment(row["subject"]):
                parsed = venmo_parser.parse(row["subject"], body.text)
                if parsed is not None:
                    # Also update the transaction's memo and payee with
                    # the Venmo note if we can find the matching txn.
                    venmo_note = parsed.pop("_venmo_note", "")
                    venmo_party = parsed.pop("_venmo_other_party", "")
                    parsed.pop("_venmo_direction", None)
                    try:
                        items_written = _write_extraction(
                            conn, row["id"], parsed, json.dumps(parsed)
                        )
                        # If the note is non-empty, find matching Venmo
                        # transactions and enrich them with the note.
                        if venmo_note or venmo_party:
                            total = _parse_amount(parsed.get("total"))
                            if total is not None:
                                lo_date = (
                                    received - timedelta(days=7)
                                ).date().isoformat()
                                hi_date = (
                                    received + timedelta(days=7)
                                ).date().isoformat()
                                # Memo/payee live on postings in v2. Update the
                                # non-equity legs of any Venmo txn that matches
                                # this receipt's amount + date window.
                                conn.execute(
                                    """
                                    UPDATE postings
                                    SET memo = COALESCE(?, memo),
                                        payee = COALESCE(?, payee)
                                    WHERE account_id NOT LIKE 'equity:%'
                                      AND ABS(ABS(amount) - ?) <= 0.05
                                      AND txn_id IN (
                                        SELECT id FROM transactions_v2
                                        WHERE date BETWEEN ? AND ?
                                          AND LOWER(description) LIKE '%venmo%'
                                      )
                                    """,
                                    (
                                        venmo_note or None,
                                        f"Venmo → {venmo_party}" if venmo_party else None,
                                        total,
                                        lo_date,
                                        hi_date,
                                    ),
                                )
                        stats.extracted += 1
                        stats.items_written += items_written
                        print(
                            f"  {row['id']}  venmo    "
                            f"{venmo_party[:20] if venmo_party else 'Venmo':20}  "
                            f"{venmo_note[:40] if venmo_note else '(no note)'}"
                        )
                        conn.commit()
                        continue
                    except Exception as e:
                        _mark_failed(conn, row["id"], f"venmo write error: {e}")
                        stats.failed += 1
                        conn.commit()
                        continue

            # TeamWork / Square invoice fast path. Deterministic pipe-table
            # format; NuExtract misses single-item invoices and sometimes
            # produces malformed JSON on long ones, so parse directly.
            is_square = "messaging.squareup.com" in (row["from_addr"] or "").lower()
            if is_square:
                parsed = teamwork_parser.parse(body.text)
                if parsed is not None and parsed.get("items"):
                    try:
                        items_written = _write_extraction(
                            conn, row["id"], parsed, json.dumps(parsed)
                        )
                        stats.extracted += 1
                        stats.items_written += items_written
                        print(
                            f"  {row['id']}  square   "
                            f"{(parsed.get('merchant') or '')[:20]}  "
                            f"+{items_written} items"
                        )
                        conn.commit()
                        continue
                    except Exception as e:
                        _mark_failed(conn, row["id"], f"square write error: {e}")
                        stats.failed += 1
                        conn.commit()
                        continue
                # Parser returned nothing → fall through to NuExtract.

            # Amazon fast path: templated text parser, no LLM.
            if sender_type == "amazon":
                parsed = amazon_parser.parse(body.text, matched_amount=candidate)
                if parsed is not None and parsed.get("items"):
                    try:
                        items_written = _write_extraction(
                            conn, row["id"], parsed, json.dumps(parsed)
                        )
                        stats.extracted += 1
                        stats.amazon_parsed += 1
                        stats.items_written += items_written
                        merchant = parsed.get("merchant") or "(no merchant)"
                        print(
                            f"  {row['id']}  amazon   {merchant[:20]}  "
                            f"+{items_written} items"
                        )
                        conn.commit()
                        continue
                    except Exception as e:
                        _mark_failed(conn, row["id"], f"amazon write error: {e}")
                        stats.failed += 1
                        conn.commit()
                        continue
                # Amazon parser returned nothing → fall through to NuExtract.

            try:
                raw, elapsed = _call_nuextract(_build_prompt(body, candidate))
                stats.nuextract_calls += 1
            except Exception as e:
                _mark_failed(conn, row["id"], f"nuextract error: {e}")
                stats.failed += 1
                continue

            cleaned = _clean_output(raw)
            try:
                parsed = json.loads(cleaned)
            except json.JSONDecodeError as e:
                _mark_failed(conn, row["id"], f"json decode: {e} :: {cleaned[:200]}")
                stats.failed += 1
                conn.commit()
                continue

            if not isinstance(parsed, dict):
                _mark_failed(
                    conn, row["id"], f"expected object, got {type(parsed).__name__}"
                )
                stats.failed += 1
                conn.commit()
                continue

            # Retry pass: if items came back empty on a body that clearly
            # has itemized content, run a narrower items-only extraction.
            items_list = parsed.get("items")
            items_empty = not items_list or (
                isinstance(items_list, list) and all(
                    not (isinstance(it, dict) and (it.get("name") or "").strip())
                    for it in items_list
                )
            )
            if items_empty and _looks_itemized(body.text):
                try:
                    raw2, elapsed2 = _call_nuextract(
                        _build_items_prompt(body, candidate)
                    )
                    cleaned2 = _clean_output(raw2)
                    parsed2 = json.loads(cleaned2)
                    if isinstance(parsed2, dict) and isinstance(
                        parsed2.get("items"), list
                    ):
                        parsed["items"] = parsed2["items"]
                        elapsed += elapsed2
                except Exception:
                    # Retry is best-effort; keep the original extraction.
                    pass

            try:
                items_written = _write_extraction(conn, row["id"], parsed, cleaned)
            except Exception as e:
                _mark_failed(conn, row["id"], f"write error: {e}")
                stats.failed += 1
                conn.commit()
                continue

            stats.extracted += 1
            stats.items_written += items_written
            merchant = parsed.get("merchant") or "(no merchant)"
            print(f"  {row['id']}  {elapsed:.1f}s  {merchant[:40]}  +{items_written} items")

            # Learn new subscription senders on the fly so future emails
            # from them skip NuExtract entirely.
            if sender_type is None and senders.looks_like_subscription(
                parsed, row["subject"]
            ):
                senders.upsert(
                    conn,
                    row["from_addr"],
                    "subscription",
                    learned_from="extraction",
                    note=f"auto-tagged from {row['id']}",
                )

            # Commit per-row so a later crash doesn't roll back earlier work.
            conn.commit()
    return stats


# Receipts with itemized content tend to have at least a few lines that
# contain both a word and a dollar amount near each other. This is a
# heuristic trigger for the retry pass — cheap to compute and wrong in
# either direction is tolerable (worst case: we run NuExtract once extra).
# Two patterns:
#   1. Classic: "Item name $9.99" (word + amount adjacent on same line)
#   2. Pipe-table: "Item name | $9.99" (pipe-separated from _html_to_text)
_ITEM_LINE_RE = re.compile(r"[A-Za-z][A-Za-z0-9 ,.&\-']{2,}\s+\$?\d+\.\d{2}")
_PIPE_ITEM_RE = re.compile(r"[A-Za-z][A-Za-z0-9 ,.&\-']{2,}\s*\|\s*\$[\d,]+\.\d{2}")


def _looks_itemized(text: str) -> bool:
    return (
        len(_ITEM_LINE_RE.findall(text)) >= 3
        or len(_PIPE_ITEM_RE.findall(text)) >= 2
    )


def print_report(stats: ExtractStats) -> None:
    print(
        f"\nprocessed {stats.processed}  extracted {stats.extracted}  "
        f"skipped {stats.skipped}  failed {stats.failed}  "
        f"items_written {stats.items_written}"
    )
