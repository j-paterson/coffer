"""Merchant-level classification via homepage scraping.

For non-Amazon receipts, knowing what a retailer sells lets us classify
all items in the receipt at once rather than per-item. A clothing
retailer's items are all clothing. A pet store's items are all pet.

This module:
  1. Derives the domain from a sender's From address
  2. Fetches the homepage via HTTP GET
  3. Parses <title> and <meta name="description"> with BS4
  4. Asks the local LLM to classify the merchant's category from the
     free-text self-description

Results are cached in the `merchants` table — one lookup per domain
for the lifetime of the project.

Known limitations:
  - JS-rendered SPAs with no server-side title → empty description → falls
    back to LLM on the display name alone
  - Stripe/Shopify-hosted checkouts: from_addr is receipts+xxx@stripe.com
    but the real merchant is in the display name, not the domain. We handle
    these by classifying the display name instead.
  - Mega-retailers (Amazon, Target, Costco) sell everything → stored as
    "mixed" category → skipped during item classification inheritance
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

from bs4 import BeautifulSoup

from ..db import connect

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5-coder:7b"

MIXED_RETAILERS = {"amazon.com", "target.com", "costco.com", "walmart.com", "ebay.com"}

_EMAIL_DOMAIN_RE = re.compile(r"@([\w.-]+)")
_DISPLAY_NAME_RE = re.compile(r'^"?([^"<]+)"?\s*<')


@dataclass
class MerchantLookupStats:
    total_domains: int = 0
    cached: int = 0
    fetched: int = 0
    fetch_failed: int = 0
    classified: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "total_domains": self.total_domains,
            "cached": self.cached,
            "fetched": self.fetched,
            "fetch_failed": self.fetch_failed,
            "classified": self.classified,
        }


def domain_from_email(from_addr: str) -> str | None:
    m = _EMAIL_DOMAIN_RE.search(from_addr)
    if not m:
        return None
    domain = m.group(1).lower()
    # Strip known relay domains where the actual merchant is the subdomain/display name
    if domain in ("stripe.com", "mail.anthropic.com"):
        return None
    return domain


def display_name_from_email(from_addr: str) -> str | None:
    m = _DISPLAY_NAME_RE.match(from_addr)
    if m:
        return m.group(1).strip()
    return None


def _fetch_homepage(domain: str, timeout: float = 10.0) -> str:
    """Fetch homepage HTML. Returns the raw HTML or empty string on failure."""
    for scheme in ("https", "http"):
        url = f"{scheme}://{domain}/"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (finance-pipeline; +local)",
                "Accept": "text/html",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")[:50000]
        except (urllib.error.URLError, OSError, TimeoutError):
            continue
    return ""


def _parse_description(html: str) -> str:
    """Extract title + meta description from an HTML page."""
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    parts = []
    title = soup.find("title")
    if title and title.string:
        parts.append(title.string.strip())
    meta = soup.find("meta", attrs={"name": "description"})
    if meta and meta.get("content"):
        parts.append(meta["content"].strip())
    # Also try og:description
    og = soup.find("meta", attrs={"property": "og:description"})
    if og and og.get("content"):
        parts.append(og["content"].strip())
    return " — ".join(parts)[:500]


CLASSIFY_PROMPT = """\
Based on the website description below, classify this merchant into a \
single spending category. Return only the category name: a short 1-2 word \
lowercase snake_case label (e.g. grocery, clothing, electronics, home, \
pet, outdoors, health, dining, travel, software, entertainment).

If the merchant sells many unrelated categories (like Amazon or Target), \
return "mixed".

Website description: {description}
Category:"""


def _llm_classify(description: str) -> str | None:
    """Ask the local LLM to pick a category for a merchant."""
    if not description.strip():
        return None
    payload = json.dumps(
        {
            "model": MODEL,
            "prompt": CLASSIFY_PROMPT.format(description=description[:400]),
            "stream": False,
            "options": {"temperature": 0, "num_predict": 12},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None
    raw = (data.get("response") or "").strip().lower()
    raw = re.sub(r"[^a-z0-9_]+", "_", raw).strip("_")
    return raw if raw else None


def classify_merchants() -> MerchantLookupStats:
    stats = MerchantLookupStats()
    with connect() as conn:
        # Get all unique sender domains from extracted emails
        rows = conn.execute(
            """
            SELECT DISTINCT from_addr
            FROM emails
            WHERE extraction_status = 'extracted'
            """
        ).fetchall()

        seen_domains: dict[str, str] = {}  # domain → display_name
        for row in rows:
            addr = row[0] or ""
            domain = domain_from_email(addr)
            display = display_name_from_email(addr)
            if domain and domain not in seen_domains:
                seen_domains[domain] = display or domain

        stats.total_domains = len(seen_domains)

        for domain, display in seen_domains.items():
            # Check cache
            cached = conn.execute(
                "SELECT category FROM merchants WHERE domain = ?", (domain,)
            ).fetchone()
            if cached:
                stats.cached += 1
                continue

            # Skip known mixed retailers
            if domain in MIXED_RETAILERS:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO merchants
                        (domain, display_name, category, source, fetched_at, notes)
                    VALUES (?, ?, 'mixed', 'seed', ?, 'known mega-retailer')
                    """,
                    (domain, display, datetime.now(timezone.utc).isoformat()),
                )
                stats.cached += 1
                continue

            # Fetch homepage
            html = _fetch_homepage(domain)
            description = _parse_description(html) if html else ""

            # If fetch failed, use display name for LLM classification
            source = "homepage"
            if not description:
                description = f"Merchant: {display}"
                source = "llm_only"
                stats.fetch_failed += 1
            else:
                stats.fetched += 1

            # LLM classify
            category = _llm_classify(description)
            if category:
                stats.classified += 1
            else:
                category = "unknown"

            conn.execute(
                """
                INSERT OR REPLACE INTO merchants
                    (domain, display_name, category, sells_description, source, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    domain,
                    display,
                    category,
                    description[:500],
                    source,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()
            print(f"  {domain:40}  {category:20}  {source:10}  {description[:60]}")
            time.sleep(0.5)

    return stats


def get_merchant_category(conn: sqlite3.Connection, from_addr: str) -> str | None:
    """Look up a cached merchant category by email from_addr. Returns None on miss."""
    domain = domain_from_email(from_addr)
    if not domain:
        return None
    row = conn.execute(
        "SELECT category FROM merchants WHERE domain = ?", (domain,)
    ).fetchone()
    if row and row[0] and row[0] != "mixed" and row[0] != "unknown":
        return row[0]
    return None


def print_report(stats: MerchantLookupStats) -> None:
    print(
        f"\ndomains: {stats.total_domains}  cached: {stats.cached}  "
        f"fetched: {stats.fetched}  fetch_failed: {stats.fetch_failed}  "
        f"classified: {stats.classified}"
    )
