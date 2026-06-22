"""Sender routing for email extraction (milestone 8b.1).

Maintains the `sender_profiles` table which tells the extractor what to
do with a given sender: skip, route to Amazon parser, or run NuExtract.

This replaces a hard-coded sender list with a seed + learn model — after
each NuExtract run that produces a subscription-looking result, we
upsert the sender as `subscription` so the next receipt from them skips
NuExtract entirely.
"""
from __future__ import annotations

import re
import sqlite3

# Initial seed list. Addresses we already know what they are from the
# existing cache or general knowledge. The learning pass extends this
# over time.
INITIAL_SEEDS: list[tuple[str, str, str]] = [
    # (from_addr_substring, type, note)
    # Amazon senders
    ("auto-confirm@amazon.com", "amazon", "Amazon order confirmation"),
    ("order-update@amazon.com", "amazon", "Amazon order update"),
    ("shipment-tracking@amazon.com", "noise", "shipment-only, no items"),
    ("digital-no-reply@amazon.com", "amazon", "Amazon digital purchase"),
    # Known subscriptions / recurring services
    ("accounts@1password.com", "subscription", "1Password subscription"),
    ("payments-noreply@google.com", "subscription", "Google Payments (subscriptions)"),
    ("googleplay-noreply@google.com", "subscription", "Google Play subscriptions"),
    # Apple noise
    ("no_reply@email.apple.com", "retail", "mixed — often subscription receipts, sometimes in-app purchases"),
    # Dev notifications
    ("testflight-noreply@apple.com", "noise", "TestFlight beta invites"),
    ("no_reply@testflight.apple.com", "noise", "TestFlight beta invites"),
    # Venmo (stored as 'service' because the CHECK constraint predates the
    # venmo type — routing is handled by from_addr check in extract.py)
    ("venmo@venmo.com", "service", "Venmo payment confirmations"),
    # Food / services (extract for the nice-to-have item details)
    ("noreply@uber.com", "service", "Uber receipts"),
    ("uber.us@uber.com", "service", "Uber"),
    ("no-reply@doordash.com", "service", "DoorDash"),
    # Stripe hosted
    ("invoice+statements", "subscription", "Stripe invoice (usually SaaS subscription)"),
]


def _match_seed(from_addr: str) -> tuple[str, str, str] | None:
    for pattern, t, note in INITIAL_SEEDS:
        if pattern.lower() in from_addr.lower():
            return pattern, t, note
    return None


def seed_if_empty(conn: sqlite3.Connection) -> int:
    existing = conn.execute("SELECT COUNT(*) FROM sender_profiles").fetchone()[0]
    if existing > 0:
        return 0
    # Seed by scanning the emails table for any sender matching a seed rule.
    inserted = 0
    senders = conn.execute(
        "SELECT DISTINCT from_addr FROM emails WHERE from_addr IS NOT NULL"
    ).fetchall()
    for row in senders:
        addr = row[0]
        match = _match_seed(addr)
        if match is None:
            continue
        pattern, t, note = match
        conn.execute(
            """
            INSERT OR IGNORE INTO sender_profiles (from_addr, type, learned_from, note)
            VALUES (?, ?, 'seed', ?)
            """,
            (addr, t, f"{note} [pattern: {pattern}]"),
        )
        inserted += 1
    return inserted


def lookup(conn: sqlite3.Connection, from_addr: str) -> str | None:
    """Return the routing type for a sender, or None if unknown."""
    if not from_addr:
        return None
    row = conn.execute(
        "SELECT type FROM sender_profiles WHERE from_addr = ?",
        (from_addr,),
    ).fetchone()
    return row[0] if row else None


def upsert(
    conn: sqlite3.Connection,
    from_addr: str,
    type_: str,
    learned_from: str = "extraction",
    note: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO sender_profiles (from_addr, type, learned_from, note, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(from_addr) DO UPDATE SET
          type = excluded.type,
          learned_from = excluded.learned_from,
          note = COALESCE(excluded.note, sender_profiles.note),
          updated_at = CURRENT_TIMESTAMP
        """,
        (from_addr, type_, learned_from, note),
    )


# Heuristic: decide if a just-extracted email looks like a subscription so
# we can auto-learn the sender. The goal is conservative — false negatives
# (failing to tag) just costs one future NuExtract call; false positives
# would permanently hide a retailer behind the skip list.

_SUB_HINT_RE = re.compile(
    r"\b(subscription|monthly|annual|plan|membership|renewal)\b",
    re.IGNORECASE,
)


def looks_like_subscription(parsed: dict, subject: str = "") -> bool:
    """Return True if the extraction result looks like a recurring sub."""
    merchant = (parsed.get("merchant") or "").strip()
    items = parsed.get("items") or []
    if not isinstance(items, list):
        items = []

    # Scan only subject + merchant. Item descriptions contain these words
    # in non-subscription contexts ("per plan", "renewal of framing", etc.)
    # which would otherwise false-positive a real invoice.
    if _SUB_HINT_RE.search(f"{merchant} {subject}"):
        return True

    # Single-item where item name ~= merchant is the classic sub pattern
    # (Google One → "Google One", 1Password → "1Password subscription").
    valid_items = [
        it for it in items
        if isinstance(it, dict) and (it.get("name") or "").strip()
    ]
    if len(valid_items) == 1 and merchant:
        name = valid_items[0].get("name", "").lower()
        if merchant.lower() in name or name in merchant.lower():
            return True
    return False
