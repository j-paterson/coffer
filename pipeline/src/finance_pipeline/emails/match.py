"""Match extracted receipt emails to ledger transactions.

Strict pass: amount within $0.05, date within ±3 days, pick the candidate
with best merchant token overlap. Fuzzy fallback: amount within 5%, date
within ±7 days. If fuzzy returns multiple candidates without a clear
merchant-overlap winner, mark `match-uncertain` so the user can decide.

An email without a total can't be matched — those are marked `none`.
A match cascades the transactions_v2 id into any line items from that
email (both emails.transaction_v2_id and transaction_items.transaction_v2_id
are populated in lockstep).
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from ..db import connect


STRICT_AMOUNT_DELTA = 0.05
STRICT_DATE_WINDOW = 3
FUZZY_AMOUNT_PCT = 0.05
FUZZY_DATE_WINDOW = 7

# Tokens we ignore when scoring merchant overlap — too generic to disambiguate.
STOPWORDS = {
    "the",
    "inc",
    "llc",
    "co",
    "corp",
    "and",
    "of",
    "for",
    "a",
    "an",
    "to",
    "order",
    "receipt",
    "payment",
    "purchase",
    "store",
    "shop",
    "online",
    "service",
    "services",
    "bill",
    "com",
    "pay",
}

_TOKEN_RE = re.compile(r"[a-z0-9]+")


@dataclass
class MatchStats:
    processed: int = 0
    strict: int = 0
    fuzzy: int = 0
    uncertain: int = 0
    none: int = 0
    items_linked: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "processed": self.processed,
            "strict": self.strict,
            "fuzzy": self.fuzzy,
            "uncertain": self.uncertain,
            "none": self.none,
            "items_linked": self.items_linked,
        }


# ---------- merchant overlap -----------------------------------------------


def _tokens(text: str | None) -> set[str]:
    if not text:
        return set()
    return {t for t in _TOKEN_RE.findall(text.lower()) if t not in STOPWORDS and len(t) > 1}


def _merchant_score(email_merchant: str | None, txn_row: sqlite3.Row) -> int:
    a = _tokens(email_merchant)
    # transactions_v2 has no cached merchant column — payee lives on the
    # posting and description on the txn. That's enough to score overlap.
    b = _tokens(txn_row["payee"]) | _tokens(txn_row["description"])
    return len(a & b)


# ---------- candidate search -----------------------------------------------


def _parse_iso_date(s: str) -> date:
    # transactions_v2.date is ISO; emails.receipt_date we normalized to ISO;
    # emails.received_at has a time — take the date portion.
    return datetime.fromisoformat(s[:10]).date()


def _effective_date(email_row: sqlite3.Row) -> date:
    if email_row["receipt_date"]:
        return _parse_iso_date(email_row["receipt_date"])
    return _parse_iso_date(email_row["received_at"])


def _candidates(
    conn: sqlite3.Connection,
    target_amount: float,
    target_date: date,
    date_window: int,
    amount_delta: float | None = None,
    amount_pct: float | None = None,
) -> list[sqlite3.Row]:
    lo_date = (target_date - timedelta(days=date_window)).isoformat()
    hi_date = (target_date + timedelta(days=date_window)).isoformat()

    if amount_delta is not None:
        lo_amt = target_amount - amount_delta
        hi_amt = target_amount + amount_delta
    elif amount_pct is not None:
        span = target_amount * amount_pct
        lo_amt = target_amount - span
        hi_amt = target_amount + span
    else:
        raise ValueError("need amount_delta or amount_pct")

    # Spend is stored as a negative amount on the user-side posting; we
    # compare on abs(amount) to match receipt totals, which are positive.
    # Equity postings (the bookkeeping opposing leg) are excluded so a
    # single txn contributes at most one user-side candidate row.
    rows = conn.execute(
        """
        SELECT t.id, p.account_id, t.date, p.amount, t.description, p.payee
        FROM transactions_v2 t
        JOIN postings p ON p.txn_id = t.id
        WHERE t.date BETWEEN ? AND ?
          AND p.account_id NOT LIKE 'equity:%'
          AND ABS(p.amount) BETWEEN ? AND ?
        """,
        (lo_date, hi_date, lo_amt, hi_amt),
    ).fetchall()
    # Real cross-account transfers have two non-equity legs and would
    # show up twice. De-dupe by txn id; merchant score is identical.
    seen: set[int] = set()
    out: list[sqlite3.Row] = []
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(r)
    return out


def _pick_best(
    candidates: list[sqlite3.Row],
    email_merchant: str | None,
    target_date: date,
) -> tuple[sqlite3.Row | None, bool]:
    """Return (best_row, is_confident).

    is_confident is True when either there's only one candidate or one
    candidate clearly beats the others on merchant overlap. Otherwise the
    caller should treat it as `uncertain`.
    """
    if not candidates:
        return None, False
    if len(candidates) == 1:
        return candidates[0], True

    scored = [
        (_merchant_score(email_merchant, row), row) for row in candidates
    ]
    scored.sort(key=lambda x: x[0], reverse=True)
    top_score = scored[0][0]
    winners = [r for s, r in scored if s == top_score]

    if top_score > 0 and len(winners) == 1:
        return winners[0], True

    # Fall back to the closest-date candidate, but report low confidence.
    winners.sort(
        key=lambda r: abs((_parse_iso_date(r["date"]) - target_date).days)
    )
    return winners[0], False


# ---------- DB writes ------------------------------------------------------


def _apply_match(
    conn: sqlite3.Connection,
    email_id: str,
    match_status: str,
    txn_v2_id: int | None,
) -> int:
    """Write match_status + v2 txn id to emails and cascade to items.

    Post-migration-032 we write the v2 id directly on both tables rather
    than going through the raw_events/event_links bridge — the email
    pipeline lives in the v2 world now.
    """
    conn.execute(
        "UPDATE emails SET match_status = ?, transaction_v2_id = ? WHERE id = ?",
        (match_status, txn_v2_id, email_id),
    )
    if txn_v2_id is None:
        return 0
    cur = conn.execute(
        "UPDATE transaction_items SET transaction_v2_id = ? WHERE email_id = ?",
        (txn_v2_id, email_id),
    )
    return cur.rowcount or 0


# ---------- public API -----------------------------------------------------


def match_all(refresh: bool = False) -> MatchStats:
    stats = MatchStats()
    with connect() as conn:
        where = (
            "extraction_status = 'extracted'"
            if refresh
            else "extraction_status = 'extracted' AND match_status = 'unmatched'"
        )
        rows = conn.execute(
            f"SELECT id, merchant, receipt_date, received_at, total_usd FROM emails WHERE {where}"
        ).fetchall()

        for email_row in rows:
            stats.processed += 1
            total = email_row["total_usd"]
            if total is None or total <= 0:
                _apply_match(conn, email_row["id"], "none", None)
                stats.none += 1
                print(f"  {email_row['id'][:18]}  no total → none")
                continue

            target_date = _effective_date(email_row)
            merchant = email_row["merchant"]

            strict = _candidates(
                conn, total, target_date,
                date_window=STRICT_DATE_WINDOW,
                amount_delta=STRICT_AMOUNT_DELTA,
            )
            best, confident = _pick_best(strict, merchant, target_date)
            if best is not None and confident:
                linked = _apply_match(conn, email_row["id"], "strict", best["id"])
                stats.strict += 1
                stats.items_linked += linked
                print(
                    f"  {email_row['id'][:18]}  strict → v2:{best['id']:<8}  "
                    f"{best['date']} {best['amount']:.2f} "
                    f"{best['payee'] or (best['description'] or '')[:30]}"
                )
                continue

            fuzzy = _candidates(
                conn, total, target_date,
                date_window=FUZZY_DATE_WINDOW,
                amount_pct=FUZZY_AMOUNT_PCT,
            )
            best, confident = _pick_best(fuzzy, merchant, target_date)
            if best is None:
                _apply_match(conn, email_row["id"], "none", None)
                stats.none += 1
                print(f"  {email_row['id'][:18]}  no candidates → none")
                continue
            status = "fuzzy" if confident else "uncertain"
            linked = _apply_match(conn, email_row["id"], status, best["id"])
            if confident:
                stats.fuzzy += 1
            else:
                stats.uncertain += 1
            stats.items_linked += linked
            print(
                f"  {email_row['id'][:18]}  {status} → v2:{best['id']:<8}  "
                f"{best['date']} {best['amount']:.2f} "
                f"{best['payee'] or (best['description'] or '')[:30]}"
            )

    return stats


def print_report(stats: MatchStats) -> None:
    print(
        f"\nprocessed {stats.processed}  "
        f"strict {stats.strict}  fuzzy {stats.fuzzy}  "
        f"uncertain {stats.uncertain}  none {stats.none}  "
        f"items_linked {stats.items_linked}"
    )
