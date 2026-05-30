"""Venmo payment parser.

Venmo confirmation emails have a consistent structure:

  Subject: "You paid <name> $<amount>" or "<name> paid you $<amount>"
  Body HTML (parsed to text):
    You paid <name>
    $ <amount>
    <note>
    See transaction
    Transaction details
    Date <date>
    ...
    Transaction ID <id>

This parser extracts: direction, other_party, amount, note, date,
and venmo_txn_id. Returns a NuExtract-shaped dict so the existing
write path handles it uniformly.

The note is the key value add — the bank only shows "VENMO PAYMENT
1049125722834" but the note says "Pet Sitting (Feb 15th - 21st)"
or "dinner split" or whatever the user typed.
"""
from __future__ import annotations

import re

# Subject patterns
_SUBJECT_YOU_PAID_RE = re.compile(
    r"^You paid (.+?) \$(\d[\d,.]*\d)$"
)
_SUBJECT_PAID_YOU_RE = re.compile(
    r"^(.+?) paid you \$(\d[\d,.]*\d)$"
)

# Body patterns for the note — appears between the dollar amount and
# "See transaction". We grab everything in between and strip whitespace.
_NOTE_RE = re.compile(
    r"\.(\d{2})\s*\n\s*(.+?)\s*\n\s*See transaction",
    re.DOTALL,
)

# Transaction ID in the body details section.
_TXN_ID_RE = re.compile(r"Transaction ID\s*(\d+)")

# Date in the body details section.
_DATE_RE = re.compile(r"Date\s*([A-Za-z]+ \d{1,2}, \d{4})")


def is_venmo_payment(subject: str) -> bool:
    return bool(
        _SUBJECT_YOU_PAID_RE.match(subject)
        or _SUBJECT_PAID_YOU_RE.match(subject)
    )


def parse(subject: str, body_text: str) -> dict | None:
    """Return a NuExtract-shaped dict or None if unparseable."""
    direction: str | None = None
    other_party: str | None = None
    amount_str: str | None = None

    m = _SUBJECT_YOU_PAID_RE.match(subject)
    if m:
        direction = "sent"
        other_party = m.group(1).strip()
        amount_str = m.group(2)
    else:
        m = _SUBJECT_PAID_YOU_RE.match(subject)
        if m:
            direction = "received"
            other_party = m.group(1).strip()
            amount_str = m.group(2)

    if not direction or not other_party or not amount_str:
        return None

    amount = float(amount_str.replace(",", ""))

    # Extract note from body
    note = ""
    nm = _NOTE_RE.search(body_text)
    if nm:
        raw_note = nm.group(2).strip()
        # Multi-line notes: collapse internal whitespace
        raw_note = re.sub(r"\s+", " ", raw_note)
        if raw_note and raw_note.lower() not in ("see transaction",):
            note = raw_note

    # Extract venmo transaction ID
    venmo_id = ""
    tm = _TXN_ID_RE.search(body_text)
    if tm:
        venmo_id = tm.group(1)

    # Extract date from body
    date_str = ""
    dm = _DATE_RE.search(body_text)
    if dm:
        date_str = dm.group(1)

    return {
        "merchant": "Venmo",
        "date": date_str,
        "currency": "USD",
        "subtotal": "",
        "tax": "",
        "total": f"${amount:.2f}",
        "payment_method": "",
        "order_id": venmo_id,
        "items": [
            {
                "name": f"{other_party}: {note}" if note else other_party,
                "quantity": "1",
                "unit_price": f"${amount:.2f}",
                "line_total": "",
            }
        ],
        # Extra fields not in the standard NuExtract shape, but useful
        # for the match step to update transactions.memo and payee.
        "_venmo_direction": direction,
        "_venmo_other_party": other_party,
        "_venmo_note": note,
    }
