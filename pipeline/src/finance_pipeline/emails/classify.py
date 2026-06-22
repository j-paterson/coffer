"""LLM-driven item classifier for milestone 8b.1.

Asks a local LLM (Ollama qwen2.5-coder:7b) to classify each transaction
item into a short snake_case category. No vocabulary list, no keyword
rules — the LLM picks a label freely, we normalize it for consistency,
and the dashboard deals with any drift through a lazy merge UI.

Input selection: prefers `short_name` (the LLM-cleaned 2-5 word label
from `finance shorten-items`) because it strips brand/marketing noise.
Falls back to the raw `name` when no short name is cached yet.

Normalization: lowercase, whitespace → underscore, strip punctuation,
collapse consecutive underscores. That's it. Singularization is
explicitly left out — "groceries" and "grocery" both showing up is a
merge-UI problem, not a pre-processing problem.
"""
from __future__ import annotations

import json
import re
import sqlite3
import urllib.request
from dataclasses import dataclass

from ..db import connect

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5-coder:7b"


@dataclass
class ClassifyStats:
    processed: int = 0
    classified: int = 0
    unclassified: int = 0
    by_category: dict[str, int] | None = None

    def as_dict(self) -> dict:
        return {
            "processed": self.processed,
            "classified": self.classified,
            "unclassified": self.unclassified,
            "by_category": self.by_category or {},
        }


PROMPT_TEMPLATE = """\
Classify the item below into a category. Return a single short category \
label (1-2 words, lowercase, snake_case). No explanation, no quotes, no \
punctuation.

Examples:
  Chicken thighs -> grocery
  Blueberry protein bars -> snacks
  Wall plates -> home_hardware
  Bluetooth stereo amp -> electronics
  Gloves -> clothing
  Google One -> software_subscription

Item: {item}
Category:"""


def _call_ollama(prompt: str, timeout: float = 60.0) -> str:
    payload = json.dumps(
        {
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0, "num_predict": 12},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return (data.get("response") or "").strip()


_NONWORD_RE = re.compile(r"[^a-z0-9]+")
_MULTI_US_RE = re.compile(r"_+")


def _normalize(raw: str) -> str | None:
    """Normalize an LLM-returned category label into a stable form.

    Lowercase, replace non-alphanumerics with underscores, collapse
    consecutive underscores, trim leading/trailing ones. Reject anything
    that's empty, too long (>3 tokens), or starts with a digit.
    """
    if not raw:
        return None
    first = raw.strip().split("\n", 1)[0]
    first = first.strip().lower()
    first = _NONWORD_RE.sub("_", first)
    first = _MULTI_US_RE.sub("_", first).strip("_")
    if not first:
        return None
    if first[0].isdigit():
        return None
    if first.count("_") > 2:
        # Too verbose — the model probably returned a description.
        return None
    return first


def classify_all(only_uncategorized: bool = True) -> ClassifyStats:
    stats = ClassifyStats(by_category={})
    with connect() as conn:
        where = "subcategory IS NULL" if only_uncategorized else "1=1"
        rows = conn.execute(
            f"""
            SELECT id, name, short_name
            FROM transaction_items
            WHERE {where}
            ORDER BY id
            """
        ).fetchall()

        for row in rows:
            stats.processed += 1
            target = row["short_name"] or row["name"] or ""
            if not target.strip():
                stats.unclassified += 1
                continue

            try:
                raw = _call_ollama(PROMPT_TEMPLATE.format(item=target))
            except Exception as e:
                print(f"  warn: {row['id']}: {e}")
                stats.unclassified += 1
                continue

            cat = _normalize(raw)
            if not cat:
                stats.unclassified += 1
                continue

            stats.classified += 1
            stats.by_category[cat] = stats.by_category.get(cat, 0) + 1
            # Writes to the fine-grained `subcategory` column. The broad
            # `category` column is populated by `aggregate-categories`.
            conn.execute(
                "UPDATE transaction_items SET subcategory = ? WHERE id = ?",
                (cat, row["id"]),
            )
            conn.commit()
            print(f"  {row['id']:4}  {cat:28}  <- {target[:50]}")

    return stats


def print_report(stats: ClassifyStats) -> None:
    print(
        f"\nprocessed {stats.processed}  classified {stats.classified}  "
        f"unclassified {stats.unclassified}"
    )
    if stats.by_category:
        print(f"\nby category ({len(stats.by_category)} distinct):")
        for cat, n in sorted(
            stats.by_category.items(), key=lambda x: x[1], reverse=True
        ):
            print(f"  {cat:28}  {n}")
