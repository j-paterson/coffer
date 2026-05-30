"""CoinTracker end-of-year tax lots parser.

CoinTracker's Tax tab can generate an "EOY tax lots" CSV — one row per
open tax lot at year-end, with the original USD cost basis preserved.
This is the most reliable basis source for crypto positions we can't
reconstruct from on-chain history (DeFi swaps, LP, staking rewards),
since CoinTracker has been computing FIFO basis for years.

CSV columns (note the leading spaces — CoinTracker exports them):

  Asset                                ETH, USDC, etc.
   Amount                              lot size
   Acquisition Date                    MM/DD/YYYY
   Cost Basis (USD)                    USD basis for this lot
   Wallet Name                         human label (Coinbase ETH Wallet, base...601aF2)
   Wallet Address                      EVM address or empty for exchanges
   Value at YYYY/12/31 (USD)           market value at year-end
   Staked/Lent                         TRUE/FALSE

Strategy: aggregate every open lot for a canonical symbol into a single
`cost_basis_overrides` row at symbol-only scope (account_id NULL) — the
dashboard groups holdings by canonical symbol across wallets, so a
symbol-wide override is the right granularity. The override is written
with `note='CoinTracker EOY YYYY-12-31'` and only overwrites prior CT-
sourced rows; manual user-entered overrides (e.g., SPACE basis = 0)
are left alone.
"""

from __future__ import annotations

import csv
import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path


@dataclass
class LotsStats:
    rows_total: int = 0
    symbols_total: int = 0
    overrides_written: int = 0
    overrides_skipped_manual: int = 0
    skipped_zero_qty: int = 0
    year: str | None = None


def _f(s: str | None) -> float:
    s = (s or "").strip().replace(",", "").replace("$", "")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _detect_year(fieldnames: list[str]) -> str | None:
    """Find the YYYY in a 'Value at YYYY/12/31 (USD)' header."""
    for h in fieldnames or []:
        m = re.search(r"Value at (\d{4})", h or "")
        if m:
            return m.group(1)
    return None


def _strip_keys(row: dict) -> dict:
    """CoinTracker prefixes most columns with a leading space — normalize."""
    return {(k or "").strip(): v for k, v in row.items()}


def parse(path: Path, conn: sqlite3.Connection) -> LotsStats:
    stats = LotsStats()
    by_symbol: dict[str, dict[str, float]] = defaultdict(
        lambda: {"qty": 0.0, "cost": 0.0}
    )

    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        stats.year = _detect_year(reader.fieldnames or [])
        for raw in reader:
            row = _strip_keys(raw)
            stats.rows_total += 1
            sym = (row.get("Asset") or "").strip().upper()
            if not sym:
                continue
            qty = _f(row.get("Amount"))
            if qty <= 0:
                stats.skipped_zero_qty += 1
                continue
            cost = _f(row.get("Cost Basis (USD)"))
            by_symbol[sym]["qty"] += qty
            by_symbol[sym]["cost"] += cost

    stats.symbols_total = len(by_symbol)
    note = f"CoinTracker EOY {stats.year}-12-31" if stats.year else "CoinTracker EOY"

    for sym, agg in by_symbol.items():
        existing = conn.execute(
            """
            SELECT id, note FROM cost_basis_overrides
            WHERE symbol = ? AND account_id IS NULL
            """,
            (sym,),
        ).fetchone()
        if existing is not None:
            existing_note = existing[1] or ""
            if not existing_note.startswith("CoinTracker EOY"):
                stats.overrides_skipped_manual += 1
                continue
            conn.execute(
                """
                UPDATE cost_basis_overrides
                SET cost_usd = ?, quantity_at_entry = ?, note = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (agg["cost"], agg["qty"], note, existing[0]),
            )
        else:
            conn.execute(
                """
                INSERT INTO cost_basis_overrides
                  (symbol, account_id, cost_usd, quantity_at_entry, note)
                VALUES (?, NULL, ?, ?, ?)
                """,
                (sym, agg["cost"], agg["qty"], note),
            )
        stats.overrides_written += 1

    conn.commit()
    return stats


def print_stats(stats: LotsStats) -> None:
    print(f"  year:                {stats.year}")
    print(f"  rows read:           {stats.rows_total}")
    print(f"  symbols:             {stats.symbols_total}")
    print(f"  overrides written:   {stats.overrides_written}")
    print(f"  skipped (manual):    {stats.overrides_skipped_manual}")
    if stats.skipped_zero_qty:
        print(f"  skipped (zero qty):  {stats.skipped_zero_qty}")
