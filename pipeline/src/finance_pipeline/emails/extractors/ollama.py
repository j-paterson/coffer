"""Ollama-served NuExtract receipt extractor.

Calls a locally-running Ollama HTTP API (defaults to localhost:11434)
with the NuExtract model. Overridable via env vars COFFER_OLLAMA_URL
and COFFER_RECEIPT_MODEL.

NuExtract is extractive by construction — fields it can't find stay
blank in the returned ExtractedReceipt.
"""
from __future__ import annotations

import email as stdlib_email
import json
import os
import re
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.policy import default as email_default_policy
from pathlib import Path

from bs4 import BeautifulSoup

from ..interfaces import EmailContent, ExtractedReceipt, ReceiptExtractor

OLLAMA_URL = os.environ.get("COFFER_OLLAMA_URL", "http://localhost:11434/api/generate")
MODEL = os.environ.get("COFFER_RECEIPT_MODEL", "nuextract:3.8b")

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

# ---------------------------------------------------------------------------
# .eml parsing helpers (shared with the extraction loop)
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"[ \t]+")
_BLANK_RE = re.compile(r"\n\s*\n+")


def _squeeze_whitespace(text: str) -> str:
    text = _WS_RE.sub(" ", text)
    text = _BLANK_RE.sub("\n\n", text)
    return text.strip()


def _html_to_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "head", "meta", "link"]):
        tag.decompose()
    for table in soup.find_all("table"):
        if table.find("table"):
            continue
        rows: list[str] = []
        for tr in table.find_all("tr"):
            cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if any(c for c in cells):
                rows.append(" | ".join(cells))
        if rows:
            table.replace_with("\n\n" + "\n".join(rows) + "\n\n")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for tag in soup.find_all(["p", "div", "tr", "td", "li", "h1", "h2", "h3"]):
        tag.append("\n")
    return soup.get_text()


# ---------------------------------------------------------------------------
# Field normalization helpers
# ---------------------------------------------------------------------------

_AMOUNT_RE = re.compile(
    r"-?\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
)
_DATE_MONTH_FIRST_RE = re.compile(r"([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})")
_DATE_DAY_FIRST_RE = re.compile(r"\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b")


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


def _parse_date(raw: str | None) -> str | None:
    """Pull an ISO date from messy NuExtract output."""
    if not raw:
        return None
    m = _DATE_MONTH_FIRST_RE.search(raw)
    if m:
        candidate = f"{m.group(1)} {m.group(2)} {m.group(3)}"
        for fmt in ("%b %d %Y", "%B %d %Y"):
            try:
                from datetime import datetime
                return datetime.strptime(candidate, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    m = _DATE_DAY_FIRST_RE.search(raw)
    if m:
        candidate = f"{m.group(1)} {m.group(2)} {m.group(3)}"
        for fmt in ("%d %b %Y", "%d %B %Y"):
            try:
                from datetime import datetime
                return datetime.strptime(candidate, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    m2 = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", raw)
    if m2:
        return m2.group(0)
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            from datetime import datetime
            return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------


def _build_prompt(from_addr: str, subject: str, text: str) -> str:
    tmpl = json.dumps(TEMPLATE, indent=2)
    preamble = f"From: {from_addr}\nSubject: {subject}\n\n"
    body = (preamble + text)[:12000]
    return f"<|input|>\n### Template:\n{tmpl}\n### Text:\n{body}\n<|output|>\n"


def _build_items_prompt(from_addr: str, subject: str, text: str) -> str:
    tmpl = json.dumps(ITEMS_TEMPLATE, indent=2)
    preamble = f"From: {from_addr}\nSubject: {subject}\n\n"
    body = (preamble + text)[:12000]
    return f"<|input|>\n### Template:\n{tmpl}\n### Text:\n{body}\n<|output|>\n"


# ---------------------------------------------------------------------------
# Itemized-content heuristic (used by the retry pass)
# ---------------------------------------------------------------------------

_ITEM_LINE_RE = re.compile(r"[A-Za-z][A-Za-z0-9 ,.&\-']{2,}\s+\$?\d+\.\d{2}")
_PIPE_ITEM_RE = re.compile(r"[A-Za-z][A-Za-z0-9 ,.&\-']{2,}\s*\|\s*\$[\d,]+\.\d{2}")


def _looks_itemized(text: str) -> bool:
    return (
        len(_ITEM_LINE_RE.findall(text)) >= 3
        or len(_PIPE_ITEM_RE.findall(text)) >= 2
    )


# ---------------------------------------------------------------------------
# OllamaExtractor
# ---------------------------------------------------------------------------


class OllamaExtractor(ReceiptExtractor):
    """Receipt extractor backed by Ollama-served NuExtract.

    Implements the ReceiptExtractor interface. The .extract() method takes
    an EmailContent with pre-parsed fields, calls the Ollama API, and returns
    an ExtractedReceipt.
    """

    def __init__(self, url: str | None = None, model: str | None = None) -> None:
        self.url = url if url is not None else OLLAMA_URL
        self.model = model if model is not None else MODEL

    # ------------------------------------------------------------------
    # ReceiptExtractor interface
    # ------------------------------------------------------------------

    def extract(self, content: EmailContent) -> ExtractedReceipt:
        """Run NuExtract on the pre-parsed email content.

        Returns an ExtractedReceipt. Blank fields stay blank — extractive
        contract. Raises SystemExit if Ollama is unreachable (friendly error).
        """
        from_addr = content.from_addr
        subject = content.subject
        body_text = content.body_text
        if not body_text:
            body = _parse_eml_body(content.eml_path)
            from_addr = body.from_addr
            subject = body.subject
            body_text = body.text

        prompt = _build_prompt(from_addr, subject, body_text)
        raw, elapsed = self._call(prompt)
        cleaned = raw.replace("<|end-output|>", "").strip()

        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            parsed = {}

        if not isinstance(parsed, dict):
            parsed = {}

        # Retry pass: if items came back empty on a body that clearly
        # has itemized content, run a narrower items-only extraction.
        items_list = parsed.get("items")
        items_empty = not items_list or (
            isinstance(items_list, list) and all(
                not (isinstance(it, dict) and (it.get("name") or "").strip())
                for it in items_list
            )
        )
        if items_empty and _looks_itemized(body_text):
            try:
                raw2, _ = self._call(
                    _build_items_prompt(from_addr, subject, body_text)
                )
                cleaned2 = raw2.replace("<|end-output|>", "").strip()
                parsed2 = json.loads(cleaned2)
                if isinstance(parsed2, dict) and isinstance(parsed2.get("items"), list):
                    parsed["items"] = parsed2["items"]
            except Exception:
                pass  # Retry is best-effort; keep the original extraction.

        return _dict_to_receipt(parsed)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _call(self, prompt: str, timeout: float = 180.0) -> tuple[str, float]:
        """POST the prompt to Ollama. Returns (response_text, elapsed_sec)."""
        payload = json.dumps(
            {
                "model": self.model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0},
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            self.url, data=payload, headers={"Content-Type": "application/json"}
        )
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read())
        except urllib.error.URLError as e:
            raise SystemExit(
                f"Could not reach Ollama at {self.url}. "
                f"Receipt extraction needs a running Ollama server with the `{self.model}` model. "
                f"See docs/email.md for setup. Original error: {e}"
            )
        return data.get("response", ""), time.time() - t0


# ---------------------------------------------------------------------------
# Helpers used both here and from extract.py
# ---------------------------------------------------------------------------


class _EmailBody:
    def __init__(self, from_addr: str, subject: str, text: str) -> None:
        self.from_addr = from_addr
        self.subject = subject
        self.text = text


def _parse_eml_body(path: Path) -> _EmailBody:
    """Parse an .eml file and return its text body."""
    with path.open("rb") as fh:
        msg: EmailMessage = stdlib_email.message_from_binary_file(
            fh, policy=email_default_policy
        )  # type: ignore[assignment]

    from_addr = msg.get("From", "") or ""
    subject = msg.get("Subject", "") or ""

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
    content = _html_to_text(content)
    return _EmailBody(from_addr, subject, _squeeze_whitespace(content))


def _dict_to_receipt(d: dict) -> ExtractedReceipt:
    """Convert a NuExtract dict result into the canonical dataclass."""
    items = d.get("items") or []
    if not isinstance(items, list):
        items = []
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
