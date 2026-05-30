"""Ledger Live operations-export parser.

Ledger Live's "Export operations" button dumps every confirmed on-chain
transaction across every connected account into a single CSV. We use it
to extend crypto-account history beyond Zerion's 1-year chart window —
each row becomes a TransactionRow whose USD amount is the countervalue
at the time of the operation.

Account matching is by (xpub, chain inferred from Account Name):
  - Account name like "Ethereum 1" → ethereum
  - "Base Cold Wallet" / "Base Hot Wallet" / "Base 1" → base
  - "DarkWalletETH" → ethereum, "DarkWalletOP" → optimism
  - Anything else on a non-EVM chain (Cosmos, etc.) is skipped.

We match to `zerion:<chain>:<lower(xpub)>` since that's our existing
canonical ID for EVM wallet+chain rows. Unmapped xpubs are reported as
warnings so the user can add them to the Zerion sync if desired.
"""

from __future__ import annotations

import csv
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .base import ParseResult


# Account-name → chain id used in our zerion:<chain>:<addr> account ids.
_CHAIN_FROM_NAME = [
    (re.compile(r"ethereum", re.I), "ethereum"),
    (re.compile(r"(?:^base|base\s*(?:cold|hot|\d))", re.I), "base"),
    (re.compile(r"\bop\b|optim", re.I), "optimism"),
    (re.compile(r"arbitrum", re.I), "arbitrum"),
    (re.compile(r"polygon|matic", re.I), "polygon"),
    (re.compile(r"avalanche|avax", re.I), "avalanche"),
    (re.compile(r"unichain", re.I), "unichain"),
    (re.compile(r"zora", re.I), "zora"),
    (re.compile(r"scroll", re.I), "scroll"),
]


def _chain_for_account_name(name: str) -> str | None:
    for pat, chain in _CHAIN_FROM_NAME:
        if pat.search(name or ""):
            return chain
    return None


@dataclass
class LedgerParseStats:
    rows_total: int = 0
    rows_skipped_non_evm: int = 0
    rows_skipped_status: int = 0
    rows_unmapped_wallet: int = 0
    rows_skipped_zerion_authoritative: int = 0
    unmapped_wallets: set[str] = field(default_factory=set)


def parse(path: Path, conn: sqlite3.Connection) -> tuple[ParseResult, LedgerParseStats]:
    """Read a Ledger operations CSV and resolve each row to one of our
    existing zerion:<chain>:<addr> account ids. Requires a live DB
    connection so we can look up which wallets are already synced."""
    stats = LedgerParseStats()
    result = ParseResult()

    # Build a (chain, addr_lower) set of accounts we know about so we can
    # reject unmapped wallets before building a txn.
    known: set[tuple[str, str]] = set()
    addr_to_ids: dict[str, list[str]] = {}
    for (acct_id,) in conn.execute(
        "SELECT id FROM accounts WHERE active = 1 AND id LIKE 'zerion:%'"
    ).fetchall():
        parts = acct_id.split(":", 2)
        if len(parts) != 3:
            continue
        _, chain, addr = parts
        known.add((chain, addr.lower()))
        addr_to_ids.setdefault(addr.lower(), []).append(acct_id)

    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stats.rows_total += 1
            if (row.get("Status") or "").strip() != "Confirmed":
                stats.rows_skipped_status += 1
                continue
            xpub = (row.get("Account xpub") or "").strip().lower()
            if not xpub.startswith("0x"):
                # Non-EVM (Cosmos cosmos1..., BTC bc1..., etc.). Skip —
                # we have no canonical account for it in zerion:* form.
                stats.rows_skipped_non_evm += 1
                continue
            name = (row.get("Account Name") or "").strip()
            chain = _chain_for_account_name(name)
            if not chain:
                stats.rows_skipped_non_evm += 1
                continue
            if (chain, xpub) not in known:
                stats.rows_unmapped_wallet += 1
                stats.unmapped_wallets.add(f"{name} ({chain}:{xpub})")
                continue
            # Zerion's wallet chart history is authoritative for daily USD
            # totals on every mapped EVM wallet, so we don't emit Ledger
            # rows as transactions — feeding swaps / internal transfers /
            # fees into the txn-walk would distort balance reconstruction.
            # Still count them in the mapped-yet-skipped stat for report.
            stats.rows_skipped_zerion_authoritative += 1

    return result, stats


def print_stats(stats: LedgerParseStats) -> None:
    def _line(k: int, label: str) -> str:
        return f"  {k:5d}  {label}"

    print(_line(stats.rows_total, "rows in CSV"))
    print(_line(stats.rows_skipped_status, "skipped (not Confirmed)"))
    print(_line(stats.rows_skipped_non_evm, "skipped (non-EVM chain)"))
    print(_line(stats.rows_unmapped_wallet, "skipped (unmapped wallet)"))
    print(_line(stats.rows_skipped_zerion_authoritative, "mapped but Zerion-authoritative (no txn emitted)"))
    if stats.unmapped_wallets:
        print("  unmapped wallets:")
        for w in sorted(stats.unmapped_wallets):
            print(f"    - {w}")
