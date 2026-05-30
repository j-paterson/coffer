"""Double-entry ledger: raw events → balanced transactions.

Core API:
  - ``record_event(conn, source, external_id, payload, source_file=None)``
      Append to ``raw_events``. Idempotent on (source, external_id).
  - ``post_transaction(conn, date, description, postings, *, raw_ids=(),
                        derived_by='ingest', category=None)``
      Write a balanced transaction (SUM postings == 0) with audit links.
  - ``assert_balance(conn, account_id, as_of, expected_usd, source, file=None)``
      Record a ground-truth balance snapshot (replaces v1 ``balances``).

The important invariant: every call to ``post_transaction`` validates that
postings sum to zero per currency before any write lands. Violations
raise ``LedgerError`` so bugs in a normalizer surface loudly.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Iterable

UNKNOWN_COUNTERPARTY = "equity:unknown-counterparty"
OPENING_BALANCE = "equity:opening-balance"
UNRECONCILED = "equity:unreconciled"

TOLERANCE = 0.005  # dollars — rounding slack for "balances-to-zero" check


class LedgerError(RuntimeError):
    """Raised when a posting set doesn't balance."""


@dataclass
class Posting:
    account_id: str
    amount: float
    payee: str | None = None
    memo: str | None = None
    currency: str = "USD"


def record_event(
    conn: sqlite3.Connection,
    source: str,
    external_id: str,
    payload: object,
    source_file: str | None = None,
) -> int | None:
    """Append a raw_event and return its id, or None if already ingested.
    ``payload`` is serialized to JSON for audit."""
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO raw_events (source, source_file, external_id, payload)
        VALUES (?, ?, ?, ?)
        """,
        (source, source_file, external_id, json.dumps(payload, default=str)),
    )
    if cur.rowcount == 0:
        return None
    return int(cur.lastrowid or 0)


def post_transaction(
    conn: sqlite3.Connection,
    date: str,
    description: str | None,
    postings: Iterable[Posting],
    *,
    raw_ids: Iterable[int] = (),
    derived_by: str = "ingest",
    category: str | None = None,
    notes: str | None = None,
) -> int:
    """Write a balanced transaction. Enforces SUM(amount)==0 per currency."""
    ps = list(postings)
    if len(ps) < 2:
        raise LedgerError(
            f"transaction needs >=2 postings; got {len(ps)} ({description!r})"
        )
    by_ccy: dict[str, float] = {}
    for p in ps:
        by_ccy[p.currency] = by_ccy.get(p.currency, 0.0) + p.amount
    for ccy, total in by_ccy.items():
        if abs(total) > TOLERANCE:
            raise LedgerError(
                f"postings don't balance ({description!r} / {date}): "
                f"{ccy} sum = {total:.4f}"
            )

    cur = conn.execute(
        """
        INSERT INTO transactions_v2 (date, description, notes, derived_by)
        VALUES (?, ?, ?, ?)
        """,
        (date, description, notes, derived_by),
    )
    txn_id = int(cur.lastrowid or 0)
    for p in ps:
        conn.execute(
            """
            INSERT INTO postings (txn_id, account_id, amount, currency, payee, memo)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (txn_id, p.account_id, p.amount, p.currency, p.payee, p.memo),
        )
    # Category lives on transaction_items now (migration 044). Synthesize a
    # single item row carrying the category — matches migration 043's
    # backfill shape for unitemized txns.
    if category is not None:
        non_equity = sum(
            p.amount for p in ps if not p.account_id.startswith("equity:")
        )
        conn.execute(
            """
            INSERT INTO transaction_items
              (email_id, line_no, name, line_total, category, transaction_v2_id)
            VALUES (NULL, 1, ?, ?, ?, ?)
            """,
            (description or "", non_equity, category, txn_id),
        )
    for rid in raw_ids:
        conn.execute(
            "INSERT OR IGNORE INTO event_links (txn_id, raw_id) VALUES (?, ?)",
            (txn_id, rid),
        )
    return txn_id


def assert_balance(
    conn: sqlite3.Connection,
    account_id: str,
    as_of: str,
    expected_usd: float,
    source: str,
    source_file: str | None = None,
) -> None:
    """Idempotent upsert of a ground-truth balance snapshot."""
    conn.execute(
        """
        INSERT INTO balance_assertions (account_id, as_of, expected_usd, source, source_file)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, as_of, source) DO UPDATE SET
          expected_usd = excluded.expected_usd,
          source_file  = excluded.source_file
        """,
        (account_id, as_of, expected_usd, source, source_file),
    )


def note_reconciliation(
    conn: sqlite3.Connection,
    account_id: str,
    as_of: str,
    kind: str,
    detail: object,
) -> None:
    conn.execute(
        """
        INSERT INTO reconciliation_notes (account_id, as_of, kind, detail)
        VALUES (?, ?, ?, ?)
        """,
        (account_id, as_of, kind, json.dumps(detail, default=str)),
    )


def one_sided(
    account_id: str,
    amount: float,
    *,
    payee: str | None = None,
    memo: str | None = None,
) -> list[Posting]:
    """Convenience: build the canonical [known_account, unknown_counterparty]
    posting pair for a single-sided ingest where we don't yet know the
    other leg. The counterparty absorbs the opposite amount so the txn
    balances. Later, the match stage can replace the counterparty side
    with the real account when it's identified."""
    return [
        Posting(account_id=account_id, amount=amount, payee=payee, memo=memo),
        Posting(account_id=UNKNOWN_COUNTERPARTY, amount=-amount),
    ]
