"""Aggregate fine-grained item subcategories into broad canonical buckets.

`classify-items` writes fine-grained labels to `transaction_items.subcategory`
("home_lighting", "fruits", "camping_equipment", ...). Left alone, that
column ends up with dozens of near-duplicate or over-specific labels —
great for drill-down, terrible for top-level dashboard grouping.

This module runs a single LLM call that asks the model to cluster every
distinct subcategory into a smaller canonical set (1-2 word snake_case
labels), and writes the mapping back to the `category` column so the
dashboard's main donut has stable bucket counts.

Why a single call rather than per-row: the LLM needs the *whole list* to
make sensible clustering decisions. Running per-row would just produce
another round of fragmented labels. One shot, one coherent taxonomy.
"""
from __future__ import annotations

import json
import re
import sqlite3
import urllib.request
from dataclasses import dataclass, field

from ..db import connect

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5-coder:7b"


@dataclass
class AggregateStats:
    distinct_subcategories: int = 0
    distinct_categories: int = 0
    items_updated: int = 0
    mapping: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "distinct_subcategories": self.distinct_subcategories,
            "distinct_categories": self.distinct_categories,
            "items_updated": self.items_updated,
            "mapping": self.mapping,
        }


PROMPT_TEMPLATE = """\
You are designing a top-level spending dashboard. Cluster the item \
categories below into a SMALL set of 8 to 12 canonical buckets that a \
normal person would recognize at a glance (e.g. grocery, home, \
electronics, clothing, personal_care, outdoors, travel, pets, dining, \
entertainment, software, fees).

Be AGGRESSIVE about merging. The inputs are noisy LLM output and many \
near-duplicates exist. Collapse them.

Explicit merge guidance:
- Anything house/household/kitchen/cleaning/lighting/tools/hardware → home
- Anything apparel/shoes/accessories worn on the body → clothing
- Anything recurring SaaS/streaming/cloud → software
- Anything food OR drink (including alcohol and snacks and produce) → grocery
- Anything camping/hiking/sports/fitness/outdoor → outdoors
- Anything pet-related → pets
- Anything car/transport/flight/hotel/rideshare → travel
- Anything cosmetic/skincare/vitamin/hygiene → personal_care
- Anything taxes/fees/regulatory → fees

Each input maps to EXACTLY ONE canonical bucket. Canonical names are \
1-2 words, lowercase, snake_case.

Return ONLY valid JSON: an object mapping each input to its canonical \
category. No explanations, no extra keys.

Inputs:
{inputs}

Output JSON:"""


_NONWORD_RE = re.compile(r"[^a-z0-9]+")
_MULTI_US_RE = re.compile(r"_+")


def _normalize(raw: str) -> str:
    first = (raw or "").strip().lower()
    first = _NONWORD_RE.sub("_", first)
    first = _MULTI_US_RE.sub("_", first).strip("_")
    return first


def _load_distinct_subcategories(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT DISTINCT subcategory FROM transaction_items WHERE subcategory IS NOT NULL ORDER BY subcategory"
    ).fetchall()
    return [r[0] for r in rows]


def _call_ollama(prompt: str, timeout: float = 180.0) -> str:
    payload = json.dumps(
        {
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0, "num_predict": 1500},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return (data.get("response") or "").strip()


def aggregate_all() -> AggregateStats:
    stats = AggregateStats()
    with connect() as conn:
        subs = _load_distinct_subcategories(conn)
        stats.distinct_subcategories = len(subs)
        if not subs:
            return stats

        inputs_block = "\n".join(f"- {s}" for s in subs)
        raw = _call_ollama(PROMPT_TEMPLATE.format(inputs=inputs_block))

        try:
            mapping = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"LLM returned invalid JSON: {e}\nraw: {raw[:500]}")

        if not isinstance(mapping, dict):
            raise RuntimeError(f"expected JSON object, got {type(mapping).__name__}")

        normalized: dict[str, str] = {}
        for k, v in mapping.items():
            if not isinstance(k, str) or not isinstance(v, str):
                continue
            nk = _normalize(k)
            nv = _normalize(v)
            if nk and nv:
                normalized[nk] = nv

        # Make sure every input has a target, even if the LLM skipped it —
        # fall back to the input itself as its own canonical bucket.
        for s in subs:
            normalized.setdefault(s, s)

        stats.mapping = normalized
        stats.distinct_categories = len(set(normalized.values()))

        # Apply the mapping to every row.
        for sub, cat in normalized.items():
            cur = conn.execute(
                "UPDATE transaction_items SET category = ? WHERE subcategory = ?",
                (cat, sub),
            )
            stats.items_updated += cur.rowcount or 0
        conn.commit()

    return stats


def print_report(stats: AggregateStats) -> None:
    print(
        f"\ndistinct subcategories: {stats.distinct_subcategories}"
        f"  →  distinct categories: {stats.distinct_categories}"
        f"  (items updated: {stats.items_updated})"
    )
    if not stats.mapping:
        return
    print("\nmapping:")
    # Group by canonical category so the report reads naturally.
    reverse: dict[str, list[str]] = {}
    for sub, cat in stats.mapping.items():
        reverse.setdefault(cat, []).append(sub)
    for cat in sorted(reverse.keys()):
        subs = sorted(reverse[cat])
        print(f"  {cat}")
        for s in subs:
            marker = "  " if s == cat else "↳ "
            print(f"      {marker}{s}")
