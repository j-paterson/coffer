"""Amazon order-confirmation parser.

Amazon's order-confirmation emails have a stable plaintext layout once
the HTML is stripped by our normal eml reader:

    * Item name
     Quantity: N
     X.YY USD

    * Item name
     ...

    Grand Total:
    NN.NN USD

A single email can contain multiple "deliveries" each with its own list
of items and grand total. We parse each delivery section independently
and — when a `matched_amount` hint is supplied by the prefilter — return
only the section whose total matches. Otherwise we return all items
across all sections rolled into one result.

Output shape matches what NuExtract would produce so the write path
doesn't care which backend was used.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# An item block. The item name can span multiple lines because Amazon's
# product titles are very long. We stop at the Quantity line.
_ITEM_RE = re.compile(
    r"""
    ^\*\s+(.+?)\n           # *_Item name (could span lines, non-greedy)
    \s*Quantity:\s*(\d+)\s*\n   # Quantity line
    \s*([\d.]+)\s*USD       # Price line
    """,
    re.MULTILINE | re.VERBOSE | re.DOTALL,
)

_TOTAL_RE = re.compile(
    r"Grand\s+Total:\s*\n?\s*([\d.]+)\s*USD",
    re.IGNORECASE,
)

_ORDER_ID_RE = re.compile(r"Order\s*#\s*\n?\s*([\d-]+)", re.IGNORECASE)


@dataclass
class _Section:
    total: float | None
    items: list[dict]
    order_id: str | None


def _squeeze_name(name: str) -> str:
    # Collapse whitespace/newlines in product names into single spaces,
    # and strip leading asterisks or whitespace.
    return re.sub(r"\s+", " ", name).strip()


def _parse_sections(text: str) -> list[_Section]:
    """Split the body at each "Grand Total:" and walk each section.

    The layout is: items → Grand Total (for delivery 1) → items → Grand
    Total (for delivery 2) → ...
    """
    sections: list[_Section] = []

    # Find all "Grand Total" positions so we can slice the text into
    # blocks where each block ends at a total.
    total_matches = list(_TOTAL_RE.finditer(text))
    if not total_matches:
        # Single-section fallback: treat the whole body as one.
        items = _extract_items(text)
        return [_Section(total=None, items=items, order_id=_extract_order_id(text))]

    start = 0
    for tm in total_matches:
        block = text[start : tm.end()]
        total = float(tm.group(1))
        items = _extract_items(block)
        order_id = _extract_order_id(block)
        sections.append(_Section(total=total, items=items, order_id=order_id))
        start = tm.end()

    # Any trailing items after the last Grand Total? Rarely applicable.
    trailing = text[start:]
    trailing_items = _extract_items(trailing)
    if trailing_items:
        sections.append(
            _Section(total=None, items=trailing_items, order_id=_extract_order_id(trailing))
        )
    return sections


def _extract_items(block: str) -> list[dict]:
    items: list[dict] = []
    for m in _ITEM_RE.finditer(block):
        name = _squeeze_name(m.group(1))
        qty = m.group(2)
        price = m.group(3)
        items.append(
            {
                "name": name,
                "quantity": qty,
                "unit_price": f"${price}",
                "line_total": "",
            }
        )
    return items


def _extract_order_id(block: str) -> str | None:
    m = _ORDER_ID_RE.search(block)
    return m.group(1) if m else None


def parse(text: str, matched_amount: float | None = None) -> dict | None:
    """Return a NuExtract-shaped dict, or None if we found nothing useful."""
    sections = _parse_sections(text)
    if not sections:
        return None

    chosen: _Section | None = None
    if matched_amount is not None:
        for sec in sections:
            if sec.total is not None and abs(sec.total - matched_amount) <= 0.10:
                chosen = sec
                break
    if chosen is None:
        # No matched-amount preference — collapse everything into one pile
        # so a multi-delivery email returns all items under its largest total.
        items = [it for sec in sections for it in sec.items]
        if not items:
            return None
        totals = [s.total for s in sections if s.total is not None]
        return {
            "merchant": "Amazon",
            "date": "",
            "currency": "USD",
            "subtotal": "",
            "tax": "",
            "total": f"${max(totals):.2f}" if totals else "",
            "payment_method": "",
            "order_id": sections[0].order_id or "",
            "items": items,
        }

    return {
        "merchant": "Amazon",
        "date": "",
        "currency": "USD",
        "subtotal": "",
        "tax": "",
        "total": f"${chosen.total:.2f}" if chosen.total is not None else "",
        "payment_method": "",
        "order_id": chosen.order_id or "",
        "items": chosen.items,
    }
