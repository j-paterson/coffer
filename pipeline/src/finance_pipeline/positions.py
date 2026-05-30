"""Position-level identity for asset holdings.

Replaces the v1 ``holdings`` table's INSERT-OR-REPLACE-by-(account, date,
symbol) semantics with a two-table model:

  positions          — stable identity per (account, chain, contract, symbol)
  position_snapshots — every (source, date) reading, source-priority resolved

Off-chain positions use chain='' contract_address='' so the composite
unique constraint still works (SQLite NULLs are distinct in UNIQUE).

Public API:

  upsert_position(conn, account_id, symbol, *, chain='', contract_address='',
                  asset_class=None) -> int
      Get-or-create the canonical position row, return its id.

  record_snapshot(conn, position_id, as_of, source, value_usd, *,
                  quantity=None, cost_basis=None) -> None
      Idempotent insert/update of a (position, date, source) reading.

  upsert_holding(conn, account_id, symbol, as_of, source, value_usd, *,
                 chain='', contract_address='', quantity=None,
                 asset_class=None, cost_basis=None) -> None
      Convenience: combine the above two for the common ingest path.

Trust order (highest first) used at query time:
  zerion-chart > zerion > alchemy > kubera > simplefin > backfill:yfinance

Per-symbol price/qty source priority (different from balance-assertion
sources).
"""

from __future__ import annotations

import sqlite3


# Higher trust = lower index. When two sources report the same position
# at the same date, the lower-rank source's value wins at query time.
HOLDINGS_TRUST_ORDER = [
    # Source-of-record beats aggregators.
    "simplefin",                # institution's direct feed
    "zerion",                   # current on-chain
    "alchemy",                  # on-chain fallback
    "kubera",                   # aggregator snapshot
    "zerion-chart",             # historical Zerion wallet chart (no per-symbol)
    "backfill:txn-walk",        # CoinTracker-derived qty × historical price
    "backfill:zerion-fungible", # current-qty × historical Zerion fungible price
    "backfill:yfinance",        # synthesized from market prices
]
HOLDINGS_TRUST_RANK = {s: i for i, s in enumerate(HOLDINGS_TRUST_ORDER)}


def upsert_position(
    conn: sqlite3.Connection,
    account_id: str,
    symbol: str,
    *,
    chain: str = "",
    contract_address: str = "",
    asset_class: str | None = None,
) -> int:
    """Find or create the canonical position row, return its id."""
    chain = chain or ""
    contract_address = (contract_address or "").lower()
    row = conn.execute(
        """
        SELECT id FROM positions
        WHERE account_id = ? AND chain = ? AND contract_address = ?
          AND symbol = ?
        """,
        (account_id, chain, contract_address, symbol),
    ).fetchone()
    if row is not None:
        if asset_class is not None:
            conn.execute(
                "UPDATE positions SET asset_class = COALESCE(asset_class, ?) "
                "WHERE id = ?",
                (asset_class, row[0]),
            )
        return int(row[0])
    cur = conn.execute(
        """
        INSERT INTO positions
          (account_id, chain, contract_address, symbol, asset_class)
        VALUES (?, ?, ?, ?, ?)
        """,
        (account_id, chain, contract_address, symbol, asset_class),
    )
    return int(cur.lastrowid or 0)


def record_snapshot(
    conn: sqlite3.Connection,
    position_id: int,
    as_of: str,
    source: str,
    value_usd: float,
    *,
    quantity: float | None = None,
    cost_basis: float | None = None,
) -> None:
    """Idempotent: a re-sync from the same source on the same day
    updates rather than duplicates."""
    conn.execute(
        """
        INSERT INTO position_snapshots
          (position_id, as_of, source, quantity, value_usd, cost_basis)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(position_id, as_of, source) DO UPDATE SET
          quantity   = excluded.quantity,
          value_usd  = excluded.value_usd,
          cost_basis = excluded.cost_basis,
          ingested_at = CURRENT_TIMESTAMP
        """,
        (position_id, as_of, source, quantity, value_usd, cost_basis),
    )


def upsert_holding(
    conn: sqlite3.Connection,
    account_id: str,
    symbol: str,
    as_of: str,
    source: str,
    value_usd: float,
    *,
    chain: str = "",
    contract_address: str = "",
    quantity: float | None = None,
    asset_class: str | None = None,
    cost_basis: float | None = None,
) -> None:
    """One-call convenience for the typical parser flow."""
    pos_id = upsert_position(
        conn,
        account_id=account_id,
        symbol=symbol,
        chain=chain,
        contract_address=contract_address,
        asset_class=asset_class,
    )
    record_snapshot(
        conn,
        position_id=pos_id,
        as_of=as_of,
        source=source,
        value_usd=value_usd,
        quantity=quantity,
        cost_basis=cost_basis,
    )
