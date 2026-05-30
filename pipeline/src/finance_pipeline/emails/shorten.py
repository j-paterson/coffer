"""Shorten Amazon-style product titles into concise labels.

Amazon's product titles are SEO word-salad ("Brand® Model Number — Extra
Large Family Pack, 12 Count, Antibiotic Free, Organic, Non-GMO, Blueberry
Flavor, 18oz Box"). Useless as a dashboard label.

This module uses a local Ollama model to turn each title into a 2-5 word
description ("Blueberry protein bars"). Results cache to the
`transaction_items.short_name` column — each item is only LLMed once.

Model choice: qwen2.5-coder:7b is default. It's already pulled, small
enough to be fast on a 3080, and follows the "return only the answer"
constraint better than hermes3 does in testing.
"""
from __future__ import annotations

import json
import sqlite3
import time
import urllib.request
from dataclasses import dataclass

from ..db import connect

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5-coder:7b"

# Items with names shorter than this are already concise enough to leave
# alone. Saves LLM time on subscription line items like "Google One" or
# "1Password" that are the same regardless.
MIN_LENGTH = 40

SHORTEN_PROMPT_TEMPLATE = """\
Shorten the following product title to a concise 2-5 word description \
of what the item actually is. Drop brand names, sizes, marketing \
adjectives, and packaging details. Return only the shortened description \
as a single line, no quotes, no explanation.

Examples:

Input: Just Bare Chicken Natural Fresh Chicken Thighs | Antibiotic Free | Boneless | Skinless | 1.25 LB
Output: Chicken thighs

Input: RXBAR Protein Bars, Protein Snack, Snack Bars, Blueberry, 22oz Box (12 Count)
Output: Blueberry protein bars

Input: 365 by Whole Foods Market, Organic Hass Avocados, 4 Count
Output: Avocados

Input: {title}
Output:"""


@dataclass
class ShortenStats:
    processed: int = 0
    shortened: int = 0
    skipped_short: int = 0
    failed: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "processed": self.processed,
            "shortened": self.shortened,
            "skipped_short": self.skipped_short,
            "failed": self.failed,
        }


def _call_ollama(prompt: str, timeout: float = 60.0) -> str:
    payload = json.dumps(
        {
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0, "num_predict": 20},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return (data.get("response") or "").strip()


def _clean(out: str) -> str:
    # Strip quotes and trailing punctuation; take the first line.
    out = out.strip()
    if "\n" in out:
        out = out.split("\n", 1)[0].strip()
    out = out.strip("\"'`.").strip()
    # Limit to something sensible — 60 chars is more than enough for a
    # "2-5 word" description and guards against runaway generations.
    if len(out) > 60:
        out = out[:60].rstrip()
    return out


def _load_pending(
    conn: sqlite3.Connection, limit: int
) -> list[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT id, name
        FROM transaction_items
        WHERE short_name IS NULL
        ORDER BY id
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return list(rows)


def shorten_all(limit: int = 500) -> ShortenStats:
    stats = ShortenStats()
    with connect() as conn:
        rows = _load_pending(conn, limit)
        for row in rows:
            stats.processed += 1
            name = row["name"] or ""
            if len(name) < MIN_LENGTH:
                # Already short enough — mirror into short_name so we
                # don't keep retrying it on future runs.
                conn.execute(
                    "UPDATE transaction_items SET short_name = ? WHERE id = ?",
                    (name, row["id"]),
                )
                stats.skipped_short += 1
                conn.commit()
                continue
            try:
                out = _call_ollama(
                    SHORTEN_PROMPT_TEMPLATE.format(title=name)
                )
            except Exception as e:
                stats.failed += 1
                print(f"  warn: {row['id']}: {e}")
                continue
            short = _clean(out)
            if not short:
                stats.failed += 1
                continue
            conn.execute(
                "UPDATE transaction_items SET short_name = ? WHERE id = ?",
                (short, row["id"]),
            )
            stats.shortened += 1
            conn.commit()
            print(f"  {row['id']:4}  {short[:40]:40}  <- {name[:60]}")
    return stats


def print_report(stats: ShortenStats) -> None:
    print(
        f"\nprocessed {stats.processed}  shortened {stats.shortened}  "
        f"skipped_short {stats.skipped_short}  failed {stats.failed}"
    )
