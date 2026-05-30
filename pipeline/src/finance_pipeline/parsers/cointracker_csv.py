"""CoinTracker.io transaction-export parser.

CoinTracker's "Download transactions" button dumps every recorded txn
across every connected wallet/exchange into a CSV with rich USD cost-
basis columns. It covers years of history that Coinbase SimpleFIN
doesn't expose, making it the best source for a real Coinbase + Ledger
+ self-custody history backfill.

Each row represents one on-chain or exchange event. Fields of interest:

  Date                          MM/DD/YYYY HH:MM:SS
  Type                          RECEIVE|SEND|BUY|SELL|TRADE|MINT|SPAM|etc.
  Transaction ID                UUID unique per txn
  Received Quantity/Currency    what flowed IN
  Received Cost Basis (USD)     USD value of inflow
  Received Wallet               wallet that received (human label)
  Sent Quantity/Currency        what flowed OUT
  Sent Cost Basis (USD)         USD value of outflow
  Sent Wallet                   wallet that sent (human label)
  Fee Amount / Fee Currency     fee paid (ignored for USD accounting)
  Realized Return (USD)         P&L on sells (not used here)

Strategy: each row produces up to two `TransactionRow`s — one per side
(receive, send) — attached to the matching wallet account in our DB.
The wallet-string → account-id mapping is built on-the-fly by scanning
live Coinbase sub-accounts (keyed by asset symbol) and Zerion wallets
(keyed by EVM address). Unmapped wallet names are logged as warnings
so the user can decide whether to map them.
"""

from __future__ import annotations

import csv
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .base import ParseResult, TransactionRow


@dataclass
class CoinTrackerStats:
    rows_total: int = 0
    rows_unique: int = 0
    txns_emitted: int = 0
    skipped_no_wallet: int = 0
    skipped_zero_usd: int = 0
    unmapped_wallets: dict[str, int] = field(default_factory=dict)


_COINBASE_WALLET_RE = re.compile(
    r"^Coinbase(?:\s+Pro)?\s+(?P<sym>[A-Z]{2,10})\s+Wallet\b"
)
_COINBASE_CASH_RE = re.compile(r"^Coinbase\s+(?:Cash|Pro\s+USD)\s*\(?USD\)?", re.I)
_COINBASE_STAKED_RE = re.compile(r"^Coinbase\s+Staked\s+(?P<sym>[A-Z]+)", re.I)


Resolver = Callable[[str, str | None], str | None]


def _build_resolver(conn: sqlite3.Connection) -> Resolver:
    """Return a `resolve(label, address) -> account_id | None` closure
    that knows about every Coinbase sub-account + Zerion wallet in the
    current DB."""
    coinbase_by_sym: dict[str, str] = {}
    for acct_id, name in conn.execute(
        """
        SELECT id, display_name FROM accounts
        WHERE active = 1 AND institution = 'Coinbase'
        """
    ).fetchall():
        m = re.match(r"^([A-Z]{2,10})\s+Wallet", name or "")
        if m:
            coinbase_by_sym.setdefault(m.group(1), acct_id)
        # Cash (USD)
        if "Cash (USD)" in (name or ""):
            coinbase_by_sym.setdefault("USD", acct_id)
        # Staked ATOM etc.
        m2 = re.match(r"^Staked\s+([A-Z]+)", name or "")
        if m2:
            coinbase_by_sym.setdefault(m2.group(1), acct_id)

    # 2. Zerion per-chain accounts keyed by lowercase address.
    zerion_by_addr: dict[str, list[str]] = {}
    for (acct_id,) in conn.execute(
        "SELECT id FROM accounts WHERE active = 1 AND id LIKE 'zerion:%'"
    ).fetchall():
        parts = acct_id.split(":", 2)
        if len(parts) == 3:
            zerion_by_addr.setdefault(parts[2].lower(), []).append(acct_id)

    def resolve(label: str, address: str | None = None) -> str | None:
        if not label and not address:
            return None
        # 1. Coinbase sub-account by symbol in label.
        if label:
            if _COINBASE_CASH_RE.match(label):
                return coinbase_by_sym.get("USD")
            m = _COINBASE_WALLET_RE.match(label)
            if m:
                hit = coinbase_by_sym.get(m.group("sym"))
                if hit:
                    return hit
            m = _COINBASE_STAKED_RE.match(label)
            if m:
                hit = coinbase_by_sym.get(m.group("sym").upper())
                if hit:
                    return hit
        # 2. Explicit EVM address from the CoinTracker row (preferred
        # over label parsing — handles ENS names like realitycrafter.eth
        # and ambiguous "Base Hot Wallet" labels).
        addr_lower = (address or "").strip().lower()
        label_lower = (label or "").lower()
        if addr_lower.startswith("0x") and len(addr_lower) == 42:
            ids = zerion_by_addr.get(addr_lower) or []
            if ids:
                # Prefer chain that matches a hint in the label
                # (e.g. "(Ethereum)" or "Base Hot Wallet").
                for i in ids:
                    chain = i.split(":")[1]
                    if chain in label_lower:
                        return i
                return ids[0]
        # 3. Hex-suffix fallback on the label (e.g. "Ethereum Wallet ...601aF2").
        sufm = re.search(r"([0-9a-fA-F]{4,8})$", label or "")
        if sufm:
            suffix = sufm.group(1).lower()
            for addr, ids in zerion_by_addr.items():
                if addr.endswith(suffix):
                    for i in ids:
                        chain = i.split(":")[1]
                        if chain in label_lower:
                            return i
                    return ids[0]
        return None

    return resolve


def _parse_dt(s: str) -> str | None:
    s = (s or "").strip()
    # MM/DD/YYYY HH:MM:SS
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if not m:
        return None
    mo, d, y = m.groups()
    try:
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    except ValueError:
        return None


def _usd(s: str) -> float:
    s = (s or "").strip().replace(",", "").replace("$", "")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse(
    paths: list[Path], conn: sqlite3.Connection
) -> tuple[ParseResult, CoinTrackerStats]:
    stats = CoinTrackerStats()
    result = ParseResult()

    resolver = _build_resolver(conn)

    seen_ids: set[str] = set()
    # Stream across all files, dedup by the CoinTracker UUID.
    for path in paths:
        with path.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                stats.rows_total += 1
                tid = (row.get("Transaction ID") or "").strip()
                if not tid or tid in seen_ids:
                    continue
                seen_ids.add(tid)
                stats.rows_unique += 1

                date = _parse_dt(row.get("Date") or "")
                if not date:
                    continue
                op_type = (row.get("Type") or "").strip()
                tx_hash = (row.get("Transaction Hash") or "").strip()

                for side in ("Received", "Sent"):
                    wallet = (row.get(f"{side} Wallet") or "").strip()
                    if not wallet:
                        continue
                    address = (row.get(f"{side} Address") or "").strip()
                    account_id = resolver(wallet, address)
                    if not account_id:
                        stats.unmapped_wallets[wallet] = (
                            stats.unmapped_wallets.get(wallet, 0) + 1
                        )
                        continue
                    # Zerion-tracked wallets have authoritative daily
                    # chart anchors; DeFi activity (LP, swaps, trades)
                    # from CoinTracker creates phantom balance deltas
                    # if fed into the txn-walk. Skip them — the zerion
                    # chart is truth for these wallets.
                    if account_id.startswith("zerion:"):
                        continue
                    # USD amount from this wallet's perspective:
                    #   Received side → inflow → +cost_basis
                    #   Sent side     → outflow → -cost_basis
                    cb = _usd(row.get(f"{side} Cost Basis (USD)") or "")
                    if cb <= 0:
                        stats.skipped_zero_usd += 1
                        continue
                    amt = cb if side == "Received" else -cb
                    qty = row.get(f"{side} Quantity") or ""
                    cur = (row.get(f"{side} Currency") or "").strip()
                    desc = f"{op_type} {qty} {cur}".strip()
                    id_ = f"cointracker:{tid}:{side.lower()}"
                    result.transactions.append(
                        TransactionRow(
                            id=id_,
                            account_id=account_id,
                            date=date,
                            amount=amt,
                            description=desc,
                            source_file=path.name,
                            payee=wallet,
                            memo=tx_hash or None,
                        )
                    )
                    stats.txns_emitted += 1
    return result, stats


def print_stats(stats: CoinTrackerStats) -> None:
    print(f"  rows read:         {stats.rows_total}")
    print(f"  unique txns:       {stats.rows_unique}")
    print(f"  transactions out:  {stats.txns_emitted}")
    print(f"  skipped (zero USD): {stats.skipped_zero_usd}")
    if stats.unmapped_wallets:
        top = sorted(stats.unmapped_wallets.items(), key=lambda x: -x[1])[:10]
        print(f"  unmapped wallets (top 10 by hits):")
        for w, n in top:
            print(f"    {n:5d}  {w}")
