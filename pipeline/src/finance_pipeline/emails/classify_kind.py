"""Materials vs Labor classifier.

Orthogonal to the item `category` axis. For each line item, asks the LLM
whether it's a physical good ("material") or a service/time charge
("labor"). For transactions that have no line items (ACH to a contractor,
handwritten checks), classifies the transaction as a whole based on its
description + surrounding context; pure-labor ACHs/checks are common in
renovation bundles and otherwise have no signal.

Model: qwen2.5-coder:7b via local Ollama, same as classify-items.
"""
from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass

from ..db import connect

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5-coder:7b"


@dataclass
class KindStats:
    items_processed: int = 0
    items_classified: int = 0
    items_unclassified: int = 0
    txns_processed: int = 0
    txns_classified: int = 0
    txns_unclassified: int = 0


ITEM_PROMPT = """\
Classify the item below as "material" or "labor".

- "material" = a physical good or product (lumber, tile, paint, a tool, \
groceries, anything you can touch).
- "labor" = a service, time charge, deposit, retainer, installation fee, \
consulting, shipping, delivery fee, or anything that represents someone's \
work rather than a physical item.

Return exactly one word: material or labor. No explanation.

Examples:
  2x4 lumber 8ft -> material
  Installation labor 4 hours -> labor
  Deposit for kitchen cabinets -> labor
  Kitchen sink -> material
  Design consultation -> labor
  Tile adhesive 5gal -> material

Item: {item}
Answer:"""

TXN_PROMPT = """\
Classify this payment as "material", "labor", or "mixed".

- "material" = payment for physical goods only.
- "labor" = payment to a contractor / service provider for their time, \
or a deposit, retainer, installation fee, or design fee.
- "mixed" = an invoice that combines labor and materials passed through \
together.

Return exactly one word: material, labor, or mixed.

Examples:
  "Home Depot purchase $234" -> material
  "TeamWork Home Designs invoice deposit $8000" -> labor
  "Check to cabinet maker $14000" -> mixed
  "Painter invoice paint + labor $2400" -> mixed
  "Electrician service call $350" -> labor

Description: {desc}
Amount: ${amount}
Answer:"""


def _call_ollama(prompt: str, timeout: float = 60.0) -> str:
    payload = json.dumps(
        {
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0, "num_predict": 5},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return (data.get("response") or "").strip()


_WORD_RE = re.compile(r"[a-z]+")


def _parse_item_answer(raw: str) -> str | None:
    m = _WORD_RE.search(raw.lower())
    if not m:
        return None
    w = m.group(0)
    if w in ("material", "materials"):
        return "material"
    if w in ("labor", "labour", "service", "services"):
        return "labor"
    return None


def _parse_txn_answer(raw: str) -> str | None:
    m = _WORD_RE.search(raw.lower())
    if not m:
        return None
    w = m.group(0)
    if w in ("material", "materials"):
        return "material"
    if w in ("labor", "labour"):
        return "labor"
    if w in ("mixed", "both"):
        return "mixed"
    return None


def classify_items(only_unclassified: bool = True) -> KindStats:
    stats = KindStats()
    with connect() as conn:
        where = "kind IS NULL" if only_unclassified else "1=1"
        rows = conn.execute(
            f"""
            SELECT id, name, short_name, category
            FROM transaction_items
            WHERE {where}
            ORDER BY id
            """
        ).fetchall()
        for row in rows:
            stats.items_processed += 1
            target = row["short_name"] or row["name"] or ""
            if not target.strip():
                stats.items_unclassified += 1
                continue
            # Append the category (if any) to the prompt so the model can
            # pivot on it — e.g. "labor_deposit" in the category field is
            # a strong labor signal.
            item_text = target
            if row["category"]:
                item_text = f"{target} (category: {row['category']})"
            try:
                raw = _call_ollama(ITEM_PROMPT.format(item=item_text))
            except Exception as e:
                print(f"  warn item {row['id']}: {e}")
                stats.items_unclassified += 1
                continue
            kind = _parse_item_answer(raw)
            if not kind:
                stats.items_unclassified += 1
                continue
            stats.items_classified += 1
            conn.execute(
                "UPDATE transaction_items SET kind = ? WHERE id = ?",
                (kind, row["id"]),
            )
            conn.commit()
            print(f"  item {row['id']:5}  {kind:8}  <- {target[:60]}")
    return stats


def classify_txns(
    only_unclassified: bool = True,
    only_bundled: bool = True,
) -> KindStats:
    """Classify whole transactions that have no line items.

    `only_bundled=True` restricts to transactions inside a bundle (the
    renovation / project bundles are where the Material/Labor axis
    matters — a lone grocery-store charge doesn't need a Labor tag).
    """
    stats = KindStats()
    with connect() as conn:
        where = []
        if only_unclassified:
            where.append("t.kind IS NULL")
        if only_bundled:
            where.append("t.trip_id IS NOT NULL")
        # Only transactions without items; itemized receipts get their
        # kind from the items axis.
        where.append(
            "NOT EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transaction_v2_id = t.id)"
        )
        # And only outflows (credits aren't Material/Labor).
        where.append(
            "EXISTS (SELECT 1 FROM postings p WHERE p.txn_id = t.id AND p.amount < 0)"
        )
        where_sql = " AND ".join(where) if where else "1=1"
        rows = conn.execute(
            f"""
            SELECT t.id, t.description,
                   (SELECT SUM(p.amount) FROM postings p WHERE p.txn_id = t.id AND p.amount < 0) AS amount
            FROM transactions_v2 t
            WHERE {where_sql}
            ORDER BY t.date
            """
        ).fetchall()
        for row in rows:
            stats.txns_processed += 1
            desc = row["description"] or ""
            amt = -float(row["amount"] or 0)
            if not desc.strip():
                stats.txns_unclassified += 1
                continue
            try:
                raw = _call_ollama(
                    TXN_PROMPT.format(desc=desc, amount=f"{amt:,.2f}")
                )
            except Exception as e:
                print(f"  warn txn {row['id']}: {e}")
                stats.txns_unclassified += 1
                continue
            kind = _parse_txn_answer(raw)
            if not kind:
                stats.txns_unclassified += 1
                continue
            stats.txns_classified += 1
            conn.execute(
                "UPDATE transactions_v2 SET kind = ? WHERE id = ?",
                (kind, row["id"]),
            )
            conn.commit()
            print(f"  txn {row['id']:6}  {kind:8}  ${amt:>9,.2f}  {desc[:50]}")
    return stats


def print_report(items: KindStats, txns: KindStats) -> None:
    print(
        f"\nitems: processed {items.items_processed}  "
        f"classified {items.items_classified}  "
        f"unclassified {items.items_unclassified}"
    )
    print(
        f"txns:  processed {txns.txns_processed}  "
        f"classified {txns.txns_classified}  "
        f"unclassified {txns.txns_unclassified}"
    )
