"""First-pass receipt extraction for known senders.

Runs before the LLM-backed ReceiptExtractor. Amazon, Venmo, and Teamwork
receipts have predictable formats we can parse deterministically — cheaper
and more accurate than NuExtract for those senders.

Returns None if no sender parser matched (the eml falls through to the
configured ReceiptExtractor backend).
"""
from __future__ import annotations

from . import amazon as amazon_parser
from . import teamwork as teamwork_parser
from . import venmo as venmo_parser
from .interfaces import ExtractedReceipt


def try_sender_parsers(
    *,
    sender_type: str | None,
    from_addr: str,
    subject: str,
    body_text: str,
    candidate: float | None,
) -> ExtractedReceipt | None:
    """If the email is from a known sender, parse it deterministically.

    Parameters are the per-row context already computed by the extraction
    loop — passing them avoids re-parsing the .eml file.

    Returns None to signal fall-through to the LLM extractor.
    """
    # Venmo fast path: parse payment confirmation from subject + body.
    # Routed by from_addr check (not sender_profiles type) because the
    # migration 008 CHECK constraint predates the venmo type.
    is_venmo = "venmo@venmo.com" in (from_addr or "").lower()
    if is_venmo and venmo_parser.is_venmo_payment(subject):
        result = venmo_parser.parse(subject, body_text)
        if result is not None:
            return _dict_to_receipt(result)

    # TeamWork / Square invoice fast path.
    is_square = "messaging.squareup.com" in (from_addr or "").lower()
    if is_square:
        result = teamwork_parser.parse(body_text)
        if result is not None and result.get("items"):
            return _dict_to_receipt(result)
        # Parser returned nothing → fall through to LLM extractor.
        return None

    # Amazon fast path: templated text parser, no LLM.
    if sender_type == "amazon":
        result = amazon_parser.parse(body_text, matched_amount=candidate)
        if result is not None and result.get("items"):
            return _dict_to_receipt(result)
        # Amazon parser returned nothing → fall through to LLM extractor.
        return None

    return None


def _dict_to_receipt(d: dict) -> ExtractedReceipt:
    """Convert a sender-parser dict result into the canonical dataclass."""
    # Pop private venmo-only keys so they don't end up in items.
    d = {k: v for k, v in d.items() if not k.startswith("_")}

    items = d.get("items") or []
    if not isinstance(items, list):
        items = []

    from .extractors.ollama import _parse_amount, _parse_date

    return ExtractedReceipt(
        merchant=d.get("merchant") or "",
        date=_parse_date(d.get("date")) or "",
        currency=(d.get("currency") or "").upper() or "",
        subtotal=_parse_amount(d.get("subtotal")),
        tax=_parse_amount(d.get("tax")),
        total=_parse_amount(d.get("total")),
        payment_method=d.get("payment_method") or "",
        order_id=d.get("order_id") or "",
        items=[it for it in items if isinstance(it, dict)],
    )
