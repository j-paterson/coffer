"""Reconstruct cost basis for on-chain DEX activity.

Walks cached Alchemy transfers in ``raw_events`` (source ``alchemy-history``),
groups them by (tx_hash, chain, wallet), and identifies swaps / disposals
by net token flow. Each confirmed event gets a row in
``derived_cost_basis_events`` with USD valuation from ``asset_prices``.

Rules we apply:
  - A group with exactly one asset net-in AND at least one priceable asset
    net-out → **acquisition**. Basis = sum of |sent_qty_i * price_usd_i|.
  - A group with exactly one asset net-out AND at least one priceable asset
    net-in → **disposal**. Proceeds = sum of |recv_qty_i * price_usd_i|.
  - Anything else (LP mint/burn, multi-asset swap, pure airdrop, pure send)
    is skipped — the cases we reject need their own modeling and would
    invent basis if we forced them through.

Priceable = stablecoin (USDC/USDT/DAI/BUSD/USD1 → $1) or has a row in
``asset_prices`` for (chain, contract) on the event's date.

The walker is idempotent: a UNIQUE constraint on
(tx_hash, chain, wallet, received_symbol, sent_symbol) combined with
INSERT OR REPLACE means re-running repopulates in place.
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date as date_cls
from typing import Iterable

from . import db

STABLECOINS = frozenset({"USDC", "USDT", "DAI", "BUSD", "USD1"})


@dataclass
class DexBasisStats:
    events_processed: int = 0
    groups_examined: int = 0
    acquisitions_written: int = 0
    disposals_written: int = 0
    skipped_unpriceable: int = 0
    skipped_multi_asset: int = 0
    skipped_single_side: int = 0


@dataclass
class _Transfer:
    tx_hash: str
    chain: str
    wallet: str
    occurred_at: str        # ISO date YYYY-MM-DD
    direction: str          # 'in' or 'out'
    symbol: str             # canonical, uppercased
    contract: str           # lowercased; '' for native
    quantity: float


def _parse_external_id(external_id: str) -> tuple[str, str] | None:
    """Split `alchemy-transfer:{chain}:{wallet}:...` into (chain, wallet)."""
    parts = external_id.split(":", 4)
    if len(parts) < 3 or parts[0] != "alchemy-transfer":
        return None
    return parts[1], parts[2].lower()


def _canonical_symbol(symbol: str) -> str:
    # Mirror the TS symbolAliases rules that matter for basis bookkeeping.
    # Kept intentionally small — anything we miss here just shows up with
    # a slightly different symbol in the derived table, and the FIFO side
    # re-applies its own canonicalization on read anyway.
    s = (symbol or "").strip().upper()
    aliases = {
        "WETH": "ETH", "STETH": "ETH", "WSTETH": "ETH",
        "RETH": "ETH", "CBETH": "ETH",
        "WBTC": "BTC", "CBBTC": "BTC",
        "USDC.E": "USDC", "USDBC": "USDC", "AXLUSDC": "USDC",
    }
    return aliases.get(s, s)


def _load_transfers(conn: sqlite3.Connection) -> list[_Transfer]:
    rows = conn.execute(
        """
        SELECT external_id, payload
        FROM raw_events
        WHERE source = 'alchemy-history'
        """
    ).fetchall()
    out: list[_Transfer] = []
    for external_id, payload_json in rows:
        loc = _parse_external_id(external_id or "")
        if not loc:
            continue
        chain, wallet = loc
        try:
            p = json.loads(payload_json)
        except Exception:
            continue
        tx_hash = p.get("hash") or ""
        if not tx_hash:
            continue
        direction_raw = p.get("_direction")
        if direction_raw == "toAddress":
            direction = "in"
        elif direction_raw == "fromAddress":
            direction = "out"
        else:
            continue
        ts = (p.get("metadata") or {}).get("blockTimestamp") or ""
        occurred_at = ts[:10] if ts else ""
        if not occurred_at:
            continue
        raw_contract = p.get("rawContract") or {}
        contract = (raw_contract.get("address") or "").lower()
        symbol = _canonical_symbol(p.get("asset") or "")
        if not symbol:
            continue
        try:
            qty = float(p.get("value") or 0.0)
        except (TypeError, ValueError):
            qty = 0.0
        if qty <= 0:
            continue
        out.append(
            _Transfer(
                tx_hash=tx_hash,
                chain=chain,
                wallet=wallet,
                occurred_at=occurred_at,
                direction=direction,
                symbol=symbol,
                contract=contract,
                quantity=qty,
            )
        )
    return out


def _lookup_price(
    conn: sqlite3.Connection,
    chain: str,
    contract: str,
    symbol: str,
    as_of: str,
) -> float | None:
    """Best-effort USD price at `as_of`.

    Stablecoins pin to $1. For everything else we look up asset_prices by
    (chain, contract) preferring that date or the most recent prior date,
    then fall back to a (chain='', contract='', symbol=) lookup which
    covers native tokens like ETH where we store a chain-less row.
    """
    if symbol in STABLECOINS:
        return 1.0
    # Prefer contract-scoped lookup — most precise, handles wrapped variants.
    if contract:
        row = conn.execute(
            """
            SELECT price_usd FROM asset_prices
            WHERE chain = ? AND contract_address = ? AND as_of <= ?
              AND price_usd > 0
            ORDER BY as_of DESC, CASE source
              WHEN 'defillama' THEN 0
              WHEN 'coingecko' THEN 1
              WHEN 'geckoterminal' THEN 2
              ELSE 3
            END
            LIMIT 1
            """,
            (chain, contract, as_of),
        ).fetchone()
        if row:
            return float(row[0])
    # Native / chain-less fallback by symbol (ETH most commonly).
    row = conn.execute(
        """
        SELECT price_usd FROM asset_prices
        WHERE symbol = ? AND contract_address = '' AND as_of <= ?
          AND price_usd > 0
        ORDER BY as_of DESC
        LIMIT 1
        """,
        (symbol, as_of),
    ).fetchone()
    if row:
        return float(row[0])
    return None


def _classify_group(
    conn: sqlite3.Connection,
    transfers: list[_Transfer],
    stats: DexBasisStats,
) -> list[tuple]:
    """Return zero or more rows ready for INSERT into derived_cost_basis_events.

    Each row is a tuple matching the column order in `_INSERT_SQL`.
    """
    stats.groups_examined += 1
    if len(transfers) < 2:
        stats.skipped_single_side += 1
        return []

    # Net flow per (symbol, contract). Per-group we keep only one decimal
    # direction per asset — we treat self-canceling transfers as noise.
    net_qty: dict[tuple[str, str], float] = defaultdict(float)
    for t in transfers:
        sign = 1 if t.direction == "in" else -1
        net_qty[(t.symbol, t.contract)] += sign * t.quantity

    received = [(s, c, q) for (s, c), q in net_qty.items() if q > 1e-9]
    sent = [(s, c, -q) for (s, c), q in net_qty.items() if q < -1e-9]

    if not received and not sent:
        stats.skipped_single_side += 1
        return []

    head = transfers[0]

    # --- Acquisition: exactly one inbound asset, ≥1 priceable outbound. ---
    if len(received) == 1 and sent:
        recv_sym, recv_contract, recv_qty = received[0]
        basis = 0.0
        priceable = 0
        for s_sym, s_contract, s_qty in sent:
            p = _lookup_price(conn, head.chain, s_contract, s_sym, head.occurred_at)
            if p is None:
                continue
            basis += s_qty * p
            priceable += 1
        if priceable == 0:
            stats.skipped_unpriceable += 1
            return []
        # If multiple assets were sent, collapse them in the row by labeling
        # the sent side as the first priceable asset (symbol is informational
        # at this layer — what matters is `cost_basis_usd`). We concatenate
        # with '+' so duplicates are still distinguishable in the table.
        sent_sym = "+".join(s for s, _, _ in sent)
        sent_contract = sent[0][1]
        sent_qty_total = sum(q for _, _, q in sent)
        stats.acquisitions_written += 1
        return [
            (
                head.tx_hash,
                head.chain,
                head.wallet,
                head.occurred_at,
                recv_sym,
                recv_contract,
                recv_qty,
                sent_sym,
                sent_contract,
                sent_qty_total,
                basis,
                None,
                "swap",
            )
        ]

    # --- Disposal: exactly one outbound asset, ≥1 priceable inbound. ---
    if len(sent) == 1 and received:
        sent_sym, sent_contract, sent_qty = sent[0]
        proceeds = 0.0
        priceable = 0
        for r_sym, r_contract, r_qty in received:
            p = _lookup_price(conn, head.chain, r_contract, r_sym, head.occurred_at)
            if p is None:
                continue
            proceeds += r_qty * p
            priceable += 1
        if priceable == 0:
            stats.skipped_unpriceable += 1
            return []
        recv_sym = "+".join(s for s, _, _ in received)
        recv_contract = received[0][1]
        recv_qty_total = sum(q for _, _, q in received)
        stats.disposals_written += 1
        return [
            (
                head.tx_hash,
                head.chain,
                head.wallet,
                head.occurred_at,
                recv_sym,
                recv_contract,
                recv_qty_total,
                sent_sym,
                sent_contract,
                sent_qty,
                None,
                proceeds,
                "swap",
            )
        ]

    # Multi-asset both ways (LP mint, aggregator split, etc.). Skip.
    stats.skipped_multi_asset += 1
    return []


_INSERT_SQL = """
INSERT OR REPLACE INTO derived_cost_basis_events (
  tx_hash, chain, wallet_address, occurred_at,
  received_symbol, received_contract, received_quantity,
  sent_symbol, sent_contract, sent_quantity,
  cost_basis_usd, proceeds_usd, confidence, computed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
"""


def backfill() -> DexBasisStats:
    stats = DexBasisStats()
    with db.connect() as conn:
        transfers = _load_transfers(conn)
        stats.events_processed = len(transfers)
        groups: dict[tuple[str, str, str], list[_Transfer]] = defaultdict(list)
        for t in transfers:
            groups[(t.tx_hash, t.chain, t.wallet)].append(t)

        rows_to_insert: list[tuple] = []
        for group in groups.values():
            rows_to_insert.extend(_classify_group(conn, group, stats))

        if rows_to_insert:
            # Wipe + rewrite in one pass so removed / reclassified events
            # don't linger. The UNIQUE on the insert would otherwise leave
            # stale rows around when heuristics change.
            conn.execute("DELETE FROM derived_cost_basis_events")
            conn.executemany(_INSERT_SQL, rows_to_insert)
    return stats


def print_report(stats: DexBasisStats) -> None:
    print(f"  events processed:     {stats.events_processed}")
    print(f"  groups examined:      {stats.groups_examined}")
    print(f"  acquisitions written: {stats.acquisitions_written}")
    print(f"  disposals written:    {stats.disposals_written}")
    print(f"  skipped (unpriceable):{stats.skipped_unpriceable}")
    print(f"  skipped (multi-asset):{stats.skipped_multi_asset}")
    print(f"  skipped (single-side):{stats.skipped_single_side}")
