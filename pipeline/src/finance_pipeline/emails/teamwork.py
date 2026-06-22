"""TeamWork Home Designs / Square invoice parser.

NuExtract reliably misses single-item invoices in the Square pipe-table
format and occasionally produces malformed JSON on long multi-item ones.
The format is deterministic, so parse it directly.

Shape after `_parse_eml` flattens the HTML:

    Invoice summary

    <item name> | $<amount>
    [optional continuation lines w/ pipe but empty amount]
    ...
    Subtotal | $<amount>
    Total Due | $<amount>

Continuation lines belong to the previous item (typically the unit-price
breakdown for a multi-quantity line).
"""
from __future__ import annotations

import re


_ITEM_RE = re.compile(
    r"^(?P<name>.+?)\s*\|\s*\$(?P<amount>[\d,]+\.\d{2})\s*$"
)
_CONT_RE = re.compile(r"^(?P<cont>.+?)\s*\|\s*$")

_STOP_WORDS = {"subtotal", "total", "total due", "tax", "payments", "balance"}


def parse(body_text: str) -> dict | None:
    """Return an extraction dict matching NuExtract's TEMPLATE, or None."""
    start = body_text.find("Invoice summary")
    if start < 0:
        return None
    section = body_text[start:]
    # Stop once we hit the Subtotal/Total row — everything after is summary.
    stop_match = re.search(r"^\s*Subtotal\s*\|", section, re.MULTILINE)
    items_block = section[: stop_match.start()] if stop_match else section

    items: list[dict] = []
    for raw_line in items_block.splitlines():
        line = raw_line.strip()
        if not line or line == "Invoice summary":
            continue
        m = _ITEM_RE.match(line)
        if m:
            name = m.group("name").strip()
            if name.lower() in _STOP_WORDS:
                continue
            amount = f"${m.group('amount')}"
            items.append({
                "name": name,
                "quantity": "",
                "unit_price": amount,
                "line_total": amount,
            })
            continue
        # Continuation line: attach to the previous item.
        m2 = _CONT_RE.match(line)
        if m2 and items:
            cont = m2.group("cont").strip()
            items[-1]["name"] = f"{items[-1]['name']} {cont}"

    if not items:
        return None

    # Pull total/subtotal/date from the post-block for bookkeeping.
    total = None
    subtotal = None
    after = section[stop_match.start():] if stop_match else ""
    m_sub = re.search(r"Subtotal\s*\|\s*\$([\d,]+\.\d{2})", after)
    if m_sub:
        subtotal = f"${m_sub.group(1)}"
    m_tot = re.search(r"Total Due\s*\|\s*\$([\d,]+\.\d{2})", after)
    if m_tot:
        total = f"${m_tot.group(1)}"

    return {
        "merchant": "TeamWork Home Designs",
        "date": "",
        "currency": "",
        "subtotal": subtotal or "",
        "tax": "",
        "total": total or subtotal or "",
        "payment_method": "",
        "order_id": "",
        "items": items,
    }
