"""OpenAI GPT receipt extractor.

Calls the OpenAI Chat Completions API directly via stdlib urllib (no SDK
dependency). Reads OPENAI_API_KEY (or configured env var) for auth. Uses
response_format=json_object for guaranteed-valid JSON output.

See docs/email.md for setup. Same extractive contract as the other
extractors: fields the model can't find stay blank.
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

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_MODEL = "gpt-4o-mini"

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
    "not present in the email. Do not invent values."
)


class OpenAIExtractor(ReceiptExtractor):
    def __init__(
        self,
        api_key_env: str = "OPENAI_API_KEY",
        model: str | None = None,
    ) -> None:
        self.api_key_env = api_key_env
        self.model = model or DEFAULT_MODEL

    def extract(self, content: EmailContent) -> ExtractedReceipt:
        api_key = os.environ.get(self.api_key_env)
        if not api_key:
            raise SystemExit(
                f"OpenAI API key not set: ${self.api_key_env}. "
                f"See docs/email.md for setup."
            )

        # Use the pre-parsed body_text from EmailContent (cli.py provides this)
        body_text = content.body_text or _parse_eml_body(content.eml_path)

        request_body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": body_text},
            ],
            "response_format": {"type": "json_object"},
        }
        req = urllib.request.Request(
            OPENAI_URL,
            data=json.dumps(request_body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise SystemExit(
                f"OpenAI API error: HTTP {e.code} {e.reason}. "
                f"Check your API key and model name. See docs/email.md."
            )
        except urllib.error.URLError as e:
            raise SystemExit(
                f"Could not reach OpenAI API: {e}. See docs/email.md."
            )

        try:
            api_response = json.loads(raw)
            choices = api_response.get("choices", [])
            if not choices:
                raise ValueError("No choices in API response")
            text = choices[0]["message"]["content"]
            receipt_dict = json.loads(text)
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            raise SystemExit(
                f"Failed to parse OpenAI API response: {e}. See docs/email.md."
            )

        return _dict_to_receipt(receipt_dict)


def _parse_eml_body(eml_path: Path) -> str:
    """Extract plain-text body from an .eml file, falling back to bs4-extracted HTML."""
    with eml_path.open("rb") as f:
        msg = stdlib_email.message_from_binary_file(f)
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
    """Convert an OpenAI-extracted dict into the canonical dataclass."""
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
