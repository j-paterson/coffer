"""Receipt extraction orchestrator for milestone 8b.

Drains the `emails` table's `extraction_status='pending'` queue:

  1. Parse the cached .eml file and pull out a plain-text body.
  2. Apply the sender-specific first-pass tier (amazon, venmo, teamwork).
  3. Fall through to the configured ReceiptExtractor backend (NuExtract via
     Ollama by default) for unmatched senders.
  4. Normalize the extracted fields (parse amounts, parse dates).
  5. Update the email row and insert any line items into transaction_items.

Absolutely no hallucination path: NuExtract is extractive by construction.
Fields NuExtract leaves blank stay blank in the DB.
"""
from __future__ import annotations

import email as stdlib_email
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import default as email_default_policy
from pathlib import Path

from bs4 import BeautifulSoup

from ..config import PROJECT_ROOT
from ..db import connect
from . import senders
from . import venmo as venmo_parser
from .extractors.ollama import (
    OllamaExtractor,
    _html_to_text,
    _parse_amount,
    _parse_date,
    _parse_int,
    _squeeze_whitespace,
    MODEL,
)
from .interfaces import ExtractedReceipt, ReceiptExtractor
from .sender_parsers import try_sender_parsers


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

_BODY_DOLLAR_RE = re.compile(r"\$\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})")
_BODY_USD_RE = re.compile(
    r"(\d{1,3}(?:,\d{3})*\.\d{1,2}|\d+\.\d{1,2})\s*USD\b",
    re.IGNORECASE,
)

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
    for amt in sorted(amounts, reverse=True):
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
    receipt: ExtractedReceipt,
    raw_json: str,
    model: str = MODEL,
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
            receipt.merchant or None,
            receipt.date or None,
            receipt.total,
            receipt.currency or None,
            receipt.order_id or None,
            receipt.payment_method or None,
            model,
            datetime.now(timezone.utc).isoformat(),
            raw_json,
            email_id,
        ),
    )

    items = receipt.items or []

    # Carry over any already-matched transaction_v2_id so re-extractions on
    # previously-matched emails produce items visible to the v2-join UIs.
    known_v2_id = conn.execute(
        "SELECT transaction_v2_id FROM emails WHERE id = ?", (email_id,)
    ).fetchone()
    txn_v2_id = known_v2_id[0] if known_v2_id else None

    # Dedupe: one canonical email per (transaction_v2_id). See original
    # extract.py comment for full rationale.
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


def extract_pending(
    limit: int = 50,
    extractor: ReceiptExtractor | None = None,
) -> ExtractStats:
    """Drain the pending email queue using the given ReceiptExtractor.

    If no extractor is provided, defaults to OllamaExtractor (NuExtract via
    a locally-running Ollama server). B1.4 will wire in extractor dispatch
    from the config so the caller chooses the backend.
    """
    if extractor is None:
        extractor = OllamaExtractor()

    stats = ExtractStats()
    with connect() as conn:
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
            # running NuExtract.
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

            # First-pass tier: deterministic parsers for known senders.
            receipt = try_sender_parsers(
                sender_type=sender_type,
                from_addr=row["from_addr"] or "",
                subject=row["subject"] or "",
                body_text=body.text,
                candidate=candidate,
            )

            if receipt is not None:
                # Sender parser matched. For Venmo, also enrich the matching
                # transaction's memo and payee with the payment note.
                is_venmo = "venmo@venmo.com" in (row["from_addr"] or "").lower()
                is_amazon = sender_type == "amazon"
                is_square = "messaging.squareup.com" in (row["from_addr"] or "").lower()

                if is_venmo:
                    venmo_result = venmo_parser.parse(row["subject"] or "", body.text)
                    venmo_note = venmo_result.pop("_venmo_note", "") if venmo_result else ""
                    venmo_party = venmo_result.pop("_venmo_other_party", "") if venmo_result else ""
                    if venmo_result:
                        venmo_result.pop("_venmo_direction", None)

                try:
                    items_written = _write_extraction(
                        conn, row["id"], receipt, json.dumps(receipt.__dict__)
                    )
                    stats.extracted += 1
                    stats.items_written += items_written

                    if is_venmo:
                        if venmo_note or venmo_party:
                            total = receipt.total
                            if total is not None:
                                lo_date = (received - timedelta(days=7)).date().isoformat()
                                hi_date = (received + timedelta(days=7)).date().isoformat()
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
                        print(
                            f"  {row['id']}  venmo    "
                            f"{venmo_party[:20] if venmo_party else 'Venmo':20}  "
                            f"{venmo_note[:40] if venmo_note else '(no note)'}"
                        )
                    elif is_amazon:
                        stats.amazon_parsed += 1
                        merchant = receipt.merchant or "(no merchant)"
                        print(
                            f"  {row['id']}  amazon   {merchant[:20]}  "
                            f"+{items_written} items"
                        )
                    elif is_square:
                        print(
                            f"  {row['id']}  square   "
                            f"{(receipt.merchant or '')[:20]}  "
                            f"+{items_written} items"
                        )
                    conn.commit()
                    continue
                except Exception as e:
                    label = "venmo" if is_venmo else "amazon" if is_amazon else "square"
                    _mark_failed(conn, row["id"], f"{label} write error: {e}")
                    stats.failed += 1
                    conn.commit()
                    continue

            # LLM extractor fallback (NuExtract via Ollama by default).
            try:
                receipt = extractor.extract(
                    eml_path,
                    from_addr=body.from_addr,
                    subject=body.subject,
                    body_text=body.text,
                    candidate=candidate,
                )
                stats.nuextract_calls += 1
            except SystemExit:
                raise  # friendly Ollama-unreachable error — propagate
            except Exception as e:
                _mark_failed(conn, row["id"], f"nuextract error: {e}")
                stats.failed += 1
                continue

            try:
                items_written = _write_extraction(
                    conn, row["id"], receipt, json.dumps(receipt.__dict__)
                )
            except Exception as e:
                _mark_failed(conn, row["id"], f"write error: {e}")
                stats.failed += 1
                conn.commit()
                continue

            stats.extracted += 1
            stats.items_written += items_written
            merchant = receipt.merchant or "(no merchant)"
            print(f"  {row['id']}  {merchant[:40]}  +{items_written} items")

            # Learn new subscription senders on the fly.
            if sender_type is None and senders.looks_like_subscription(
                receipt.__dict__, row["subject"]
            ):
                senders.upsert(
                    conn,
                    row["from_addr"],
                    "subscription",
                    learned_from="extraction",
                    note=f"auto-tagged from {row['id']}",
                )

            conn.commit()
    return stats


def print_report(stats: ExtractStats) -> None:
    print(
        f"\nprocessed {stats.processed}  extracted {stats.extracted}  "
        f"skipped {stats.skipped}  failed {stats.failed}  "
        f"items_written {stats.items_written}"
    )
