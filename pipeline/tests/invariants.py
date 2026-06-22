"""Architectural invariants from ARCHITECTURE.md, encoded as
machine-checkable assertions over a sqlite3 connection.

Each invariant is a function that takes a Connection and raises
InvariantError listing the offending rows when violated. ``run_all``
runs every invariant in this module and surfaces the first failure.

Invariant catalogue:
  INV-1  every transactions_v2 row's postings sum to zero (per currency)
  INV-2  every posting.account_id references an existing accounts.id
  INV-3  every balance_assertion.source exists in data_sources(kind='assertion')
  INV-4  every position_snapshot.source exists in data_sources(kind='snapshot')
  INV-5  no accounts.merged_into cycle; chains terminate
  INV-6  data_sources.trust_rank unique within (kind, enabled=1)
  INV-7  every accounts row whose id starts 'equity:' has type='equity'
  INV-8  position_snapshots.value_usd ~= quantity * price_usd (1¢ tolerance, joined via asset_prices)
"""

from __future__ import annotations

import sqlite3

TOLERANCE = 0.005  # dollars
SNAPSHOT_TOLERANCE = 0.01  # dollars per row


class InvariantError(AssertionError):
    pass


def INV_1_postings_balance(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """SELECT txn_id, currency, ROUND(SUM(amount), 4) AS s
           FROM postings GROUP BY txn_id, currency
           HAVING ABS(s) > ?""",
        (TOLERANCE,),
    ).fetchall()
    if rows:
        details = ", ".join(f"txn_id={r[0]} {r[1]}={r[2]:+.4f}" for r in rows)
        raise InvariantError(f"INV-1 postings balance violated: {details}")


def INV_2_posting_account_exists(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """SELECT p.id, p.account_id FROM postings p
           LEFT JOIN accounts a ON a.id = p.account_id
           WHERE a.id IS NULL"""
    ).fetchall()
    if rows:
        details = ", ".join(f"posting={r[0]} account_id={r[1]!r}" for r in rows)
        raise InvariantError(f"INV-2 posting references unknown account: {details}")


def INV_3_assertion_source_known(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """SELECT DISTINCT ba.source FROM balance_assertions ba
           LEFT JOIN data_sources ds
             ON ds.name = ba.source AND ds.kind = 'assertion'
           WHERE ds.name IS NULL"""
    ).fetchall()
    if rows:
        details = ", ".join(f"{r[0]!r}" for r in rows)
        raise InvariantError(
            f"INV-3 balance_assertion source not in data_sources(kind='assertion'): {details}"
        )


def INV_4_snapshot_source_known(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """SELECT DISTINCT ps.source FROM position_snapshots ps
           LEFT JOIN data_sources ds
             ON ds.name = ps.source AND ds.kind = 'snapshot'
           WHERE ds.name IS NULL"""
    ).fetchall()
    if rows:
        details = ", ".join(f"{r[0]!r}" for r in rows)
        raise InvariantError(
            f"INV-4 position_snapshot source not in data_sources(kind='snapshot'): {details}"
        )


def INV_5_no_merge_cycles(conn: sqlite3.Connection) -> None:
    parent = {
        r[0]: r[1]
        for r in conn.execute(
            "SELECT id, merged_into FROM accounts WHERE merged_into IS NOT NULL"
        ).fetchall()
    }
    for start in parent:
        seen = {start}
        cur = parent[start]
        while cur is not None and cur in parent:
            if cur in seen:
                raise InvariantError(
                    f"INV-5 merged_into cycle detected starting at {start!r}"
                )
            seen.add(cur)
            cur = parent[cur]


def INV_6_trust_rank_unique(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """SELECT kind, trust_rank, COUNT(*) c FROM data_sources
           WHERE enabled = 1
           GROUP BY kind, trust_rank HAVING c > 1"""
    ).fetchall()
    if rows:
        details = ", ".join(f"({r[0]}, rank={r[1]}, count={r[2]})" for r in rows)
        raise InvariantError(
            f"INV-6 trust_rank duplicated within enabled (kind, rank): {details}"
        )


def INV_7_equity_account_type(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """SELECT id, type FROM accounts
           WHERE id LIKE 'equity:%' AND type != 'equity'"""
    ).fetchall()
    if rows:
        details = ", ".join(f"{r[0]!r} type={r[1]!r}" for r in rows)
        raise InvariantError(f"INV-7 equity:* account with non-equity type: {details}")


def INV_8_snapshot_qty_price_value(conn: sqlite3.Connection) -> None:
    # position_snapshots has no price_usd column; price lives in asset_prices.
    # Check via join: when a matching asset_prices row exists for (symbol, as_of,
    # source), value_usd must be within SNAPSHOT_TOLERANCE of quantity * price_usd.
    rows = conn.execute(
        """SELECT ps.id, ps.quantity, ap.price_usd, ps.value_usd
           FROM position_snapshots ps
           JOIN positions pos ON pos.id = ps.position_id
           JOIN asset_prices ap
             ON ap.symbol = pos.symbol
            AND ap.as_of   = ps.as_of
            AND ap.source  = ps.source
            AND ap.chain              = pos.chain
            AND ap.contract_address   = pos.contract_address
           WHERE ps.quantity IS NOT NULL
             AND ABS(ps.value_usd - ps.quantity * ap.price_usd) > ?""",
        (SNAPSHOT_TOLERANCE,),
    ).fetchall()
    if rows:
        details = ", ".join(
            f"id={r[0]} qty={r[1]} price={r[2]} value={r[3]}" for r in rows[:5]
        )
        raise InvariantError(
            f"INV-8 snapshot qty*price != value_usd: {details}"
            + (f" (and {len(rows)-5} more)" if len(rows) > 5 else "")
        )


_ALL = [
    INV_1_postings_balance,
    INV_2_posting_account_exists,
    INV_3_assertion_source_known,
    INV_4_snapshot_source_known,
    INV_5_no_merge_cycles,
    INV_6_trust_rank_unique,
    INV_7_equity_account_type,
    INV_8_snapshot_qty_price_value,
]


def run_all(conn: sqlite3.Connection) -> None:
    """Run every invariant. Raises on the first violation."""
    for fn in _ALL:
        fn(conn)
