"""Anthropic Claude receipt extractor.

Calls the Anthropic Messages API directly via stdlib urllib (no SDK
dependency). Reads ANTHROPIC_API_KEY (or configured env var) for auth.

See docs/email.md for setup. Uses the extractive prompt convention:
fields the model can't find stay blank.
"""
from __future__ import annotations

import email as stdlib_email
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup

from ..interfaces import EmailContent, ExtractedReceipt, ReceiptExtractor

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Same shape as OllamaExtractor's TEMPLATE — keep parity so receipts from
# different backends slot into the same DB columns.
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
        {"name": "", "quantity": "", "unit_price": "", "line_total": ""}
    ],
}


SYSTEM_PROMPT = (
    "You are a receipt-extraction tool. Given the body of a receipt email, "
    "extract the structured fields and respond with ONLY a valid JSON object "
    "matching this schema:\n\n"
    f"{json.dumps(TEMPLATE, indent=2)}\n\n"
    "Leave any field BLANK ('' for strings, empty list for items) if it is "
    "not present in the email. Do not invent values. Do not include any "
    "prose, markdown, or explanation — just the JSON object."
)


class AnthropicExtractor(ReceiptExtractor):
    def __init__(
        self,
        api_key_env: str = "ANTHROPIC_API_KEY",
        model: str | None = None,
    ) -> None:
        self.api_key_env = api_key_env
        self.model = model or DEFAULT_MODEL

    def extract(self, content: EmailContent) -> ExtractedReceipt:
        api_key = os.environ.get(self.api_key_env)
        if not api_key:
            raise SystemExit(
                f"Anthropic API key not set: ${self.api_key_env}. "
                f"See docs/email.md for setup."
            )

        # Use the pre-parsed body_text from EmailContent (cli.py provides this)
        body_text = content.body_text or _parse_eml_body(content.eml_path)

        request_body = {
            "model": self.model,
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
            "messages": [
                {"role": "user", "content": body_text},
            ],
        }
        req = urllib.request.Request(
            ANTHROPIC_URL,
            data=json.dumps(request_body).encode("utf-8"),
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise SystemExit(
                f"Anthropic API error: HTTP {e.code} {e.reason}. "
                f"Check your API key and model name. See docs/email.md."
            )
        except urllib.error.URLError as e:
            raise SystemExit(
                f"Could not reach Anthropic API: {e}. See docs/email.md."
            )

        try:
            api_response = json.loads(raw)
            # Anthropic returns content as a list of blocks; we want the text from the first text block.
            text_blocks = [b for b in api_response.get("content", []) if b.get("type") == "text"]
            if not text_blocks:
                raise ValueError("No text content in API response")
            text = text_blocks[0]["text"]
            receipt_dict = json.loads(text)
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            raise SystemExit(
                f"Failed to parse Anthropic API response: {e}. See docs/email.md."
            )

        return _dict_to_receipt(receipt_dict)


def _parse_eml_body(eml_path: Path) -> str:
    """Extract plain-text body from an .eml file, falling back to bs4-extracted HTML."""
    with eml_path.open("rb") as f:
        msg = stdlib_email.message_from_binary_file(f)
    # Walk parts and collect text/plain; fall back to text/html via bs4
    plain_parts: list[str] = []
    html_parts: list[str] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if ctype == "text/plain":
            plain_parts.append(text)
        elif ctype == "text/html":
            html_parts.append(text)
    if plain_parts:
        return "\n".join(plain_parts).strip()
    if html_parts:
        soup = BeautifulSoup("\n".join(html_parts), "html.parser")
        return soup.get_text("\n").strip()
    return ""


def _dict_to_receipt(d: dict) -> ExtractedReceipt:
    """Convert a Claude-style dict into the canonical dataclass."""
    items = d.get("items") or []
    if not isinstance(items, list):
        items = []
    return ExtractedReceipt(
        merchant=d.get("merchant", "") or "",
        date=d.get("date", "") or "",
        currency=d.get("currency", "") or "",
        subtotal=_to_float(d.get("subtotal")),
        tax=_to_float(d.get("tax")),
        total=_to_float(d.get("total")),
        payment_method=d.get("payment_method", "") or "",
        order_id=d.get("order_id", "") or "",
        items=[it for it in items if isinstance(it, dict)],
    )


def _to_float(v: object) -> float | None:
    if v in (None, "", []):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", "").replace("$", "").strip() or "0") or None
        except ValueError:
            return None
    return None
