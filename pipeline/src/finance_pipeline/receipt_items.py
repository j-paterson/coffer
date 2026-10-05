"""Keep receipt line items consistent with the transaction they itemize.

Category totals sum ``transaction_items.line_total``, so for a transaction
that a receipt email itemizes, two things must hold:

1. Only the receipt's lines count. Every ledger txn is born with one
   synthesized placeholder item (email_id NULL) carrying the full amount;
   matching a receipt attaches its lines without removing that placeholder,
   which double-counts the txn.
2. The lines sum to the money that moved, with the ledger's sign. Extractors
   emit positive prices, sometimes lose a price, and receipt totals can
   differ from the charge by tax, card fees or rounding. Some legacy rows
   also carry the txn total split evenly across lines instead of each
   line's own price.

normalize_receipt_items rewrites each such txn's lines from the receipt's
own amounts (as extracted, in `raw`): priced lines keep their share,
discounts stay negative, a line whose price was lost gets whatever the
priced lines leave unexplained, and any tax/fee/rounding gap is spread
proportionally so per-category totals still add up to the charge.

The placeholder is dropped, handing its category to the receipt lines (a
category the user picked overrides the lines' automatic ones). A
placeholder the user categorized is kept at line_total 0 instead, so that
choice outlives the receipt. The reverse also holds: a txn left with no
receipt lines, because its receipt was unmatched, re-matched elsewhere or
deleted, gets its placeholder (and its amount) back.
Idempotent: a clean txn is never touched.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field


@dataclass
class ReceiptItemStats:
    txns_checked: int = 0
    txns_fixed: int = 0
    placeholders_dropped: int = 0
    placeholders_restored: int = 0
    skipped_multi_email: list[int] = field(default_factory=list)


def _signed_cents(x: float) -> int:
    return int(round(x * 100))


def _allocate(total: int, weights: list[float]) -> list[int]:
    """Split `total` cents proportionally to signed `weights`; the parts
    always sum to exactly `total` (rounding residue lands on the largest)."""
    w_sum = sum(weights)
    if w_sum <= 0:
        weights = [1.0] * len(weights)
        w_sum = float(len(weights))
    parts = [round(total * w / w_sum) for w in weights]
    biggest = max(range(len(weights)), key=lambda i: weights[i])
    parts[biggest] += total - sum(parts)
    return parts


def _money(v: object) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace("$", "").replace(",", "").strip())
        except ValueError:
            return None
    return None


def _raw(item: sqlite3.Row) -> dict | None:
    try:
        raw = json.loads(item["raw"]) if item["raw"] else None
    except ValueError:
        return None
    return raw if isinstance(raw, dict) else None


def _weight(item: sqlite3.Row) -> float | None:
    """Receipt's own amount for a line in cents, positive for a charge and
    negative for a discount; None when the receipt gave it no amount.

    Order of trust: the receipt's line total (it already reflects pack
    pricing and per-line discounts), then unit price x quantity. The
    line_total column is only used when `raw` is unavailable, because
    legacy passes overwrote it while raw keeps what the receipt said."""
    qty = item["quantity"] or 1
    raw = _raw(item)
    if raw is not None:
        total = _money(raw.get("line_total"))
        if total is not None:
            return float(_signed_cents(total))
    if item["unit_price"] is not None:
        return _signed_cents(item["unit_price"]) * qty
    if raw is not None:
        price = _money(raw.get("unit_price"))
        return _signed_cents(price) * qty if price is not None else None
    if item["line_total"] is not None:
        return float(abs(_signed_cents(item["line_total"])))
    return None


def _target_totals(items: list[sqlite3.Row], charge: float) -> list[float]:
    total = abs(_signed_cents(charge))
    sign = -1 if charge < 0 else 1
    if len(items) == 1:
        return [sign * total / 100]
    weights = [_weight(i) for i in items]
    priced = sum(w for w in weights if w is not None)
    unpriced = [n for n, w in enumerate(weights) if w is None]
    if unpriced and priced < total:
        share = (total - priced) / len(unpriced)
        filled = [share if w is None else w for w in weights]
    else:
        filled = [0.0 if w is None else w for w in weights]
    return [sign * c / 100 for c in _allocate(total, filled)]


def _charge(conn: sqlite3.Connection, tid: int) -> float:
    return conn.execute(
        "SELECT COALESCE(SUM(amount), 0) FROM postings "
        "WHERE txn_id = ? AND account_id NOT LIKE 'equity:%'",
        (tid,),
    ).fetchone()[0]


def _restore_placeholders(conn: sqlite3.Connection, stats: ReceiptItemStats,
                          dry_run: bool) -> None:
    orphans = conn.execute(
        "SELECT id, description FROM transactions_v2 t WHERE NOT EXISTS "
        "(SELECT 1 FROM transaction_items i WHERE i.transaction_v2_id = t.id)"
    ).fetchall()
    for t in orphans:
        stats.placeholders_restored += 1
        if not dry_run:
            conn.execute(
                "INSERT INTO transaction_items "
                "(email_id, line_no, name, line_total, transaction_v2_id) "
                "VALUES (NULL, 1, ?, ?, ?)",
                (t["description"] or "", _charge(conn, t["id"]), t["id"]),
            )
    # A kept (zeroed) user placeholder whose receipt lines went away carries
    # the amount again.
    zeroed = conn.execute(
        "SELECT MIN(id) AS id, transaction_v2_id AS tid FROM transaction_items i "
        "WHERE email_id IS NULL AND line_total = 0 AND NOT EXISTS ("
        "  SELECT 1 FROM transaction_items r WHERE r.transaction_v2_id = "
        "  i.transaction_v2_id AND (r.email_id IS NOT NULL OR r.line_total != 0)) "
        "GROUP BY transaction_v2_id"
    ).fetchall()
    for z in zeroed:
        charge = _charge(conn, z["tid"])
        if _signed_cents(charge) == 0:
            continue
        stats.placeholders_restored += 1
        if not dry_run:
            conn.execute(
                "UPDATE transaction_items SET line_total = ? WHERE id = ?",
                (charge, z["id"]),
            )


def normalize_receipt_items(
    conn: sqlite3.Connection, dry_run: bool = False,
) -> ReceiptItemStats:
    saved_factory = conn.row_factory
    conn.row_factory = sqlite3.Row
    try:
        return _normalize(conn, dry_run)
    finally:
        conn.row_factory = saved_factory


def _normalize(conn: sqlite3.Connection, dry_run: bool) -> ReceiptItemStats:
    stats = ReceiptItemStats()
    _restore_placeholders(conn, stats, dry_run)
    txns = [
        r[0]
        for r in conn.execute(
            "SELECT DISTINCT transaction_v2_id FROM transaction_items "
            "WHERE email_id IS NOT NULL AND transaction_v2_id IS NOT NULL "
            "ORDER BY transaction_v2_id"
        )
    ]
    for tid in txns:
        stats.txns_checked += 1
        charge = _charge(conn, tid)
        if _signed_cents(charge) == 0:
            continue
        rows = conn.execute(
            "SELECT id, email_id, quantity, unit_price, line_total, raw, category, "
            "subcategory, category_source FROM transaction_items "
            "WHERE transaction_v2_id = ? ORDER BY line_no, id",
            (tid,),
        ).fetchall()
        receipt = [r for r in rows if r["email_id"] is not None]
        placeholders = [r for r in rows if r["email_id"] is None]
        if len({r["email_id"] for r in receipt}) > 1:
            stats.skipped_multi_email.append(tid)
            continue

        targets = _target_totals(receipt, charge)
        changed = [
            (r, t) for r, t in zip(receipt, targets)
            if r["line_total"] is None or abs(r["line_total"] - t) > 0.004
        ]
        user_pick = next(
            (p for p in placeholders if p["category_source"] == "user"), None
        )
        # The user's placeholder stays, zeroed, so their category survives the
        # receipt being unmatched or replaced later; the rest are dropped.
        stale = [
            p for p in placeholders
            if p is not user_pick or (p["line_total"] or 0) != 0
        ]
        if not changed and not stale:
            continue
        stats.txns_fixed += 1
        stats.placeholders_dropped += len(stale)
        if dry_run:
            continue

        for r, t in changed:
            conn.execute(
                "UPDATE transaction_items SET line_total = ? WHERE id = ?",
                (t, r["id"]),
            )
        donor = user_pick or next(
            (p for p in placeholders if p["category"] is not None), None
        )
        if donor is not None:
            # A user's pick on the txn beats automatic receipt-line categories;
            # otherwise only fill lines that have none. Lines the user set win.
            only_blank = "" if user_pick else "AND category IS NULL"
            conn.execute(
                "UPDATE transaction_items SET category = ?, subcategory = ?, "
                "category_source = ? "
                "WHERE transaction_v2_id = ? AND email_id IS NOT NULL "
                f"AND COALESCE(category_source, '') != 'user' {only_blank}",
                (donor["category"], donor["subcategory"],
                 donor["category_source"], tid),
            )
        for p in placeholders:
            if p is user_pick:
                conn.execute(
                    "UPDATE transaction_items SET line_total = 0 WHERE id = ?",
                    (p["id"],),
                )
            else:
                conn.execute("DELETE FROM transaction_items WHERE id = ?", (p["id"],))
    return stats


def print_report(stats: ReceiptItemStats) -> None:
    print(f"receipt-itemized txns checked: {stats.txns_checked}")
    print(f"  fixed: {stats.txns_fixed} "
          f"(placeholder items dropped: {stats.placeholders_dropped})")
    if stats.placeholders_restored:
        print(f"  placeholder items restored on itemless txns: "
              f"{stats.placeholders_restored}")
    if stats.skipped_multi_email:
        print(f"  skipped, lines from more than one receipt: "
              f"{stats.skipped_multi_email[:20]}")
