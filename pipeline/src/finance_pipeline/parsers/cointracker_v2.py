"""CoinTracker CSV → v2 ledger.

CoinTracker exports are already double-entry: each row carries a Sent
Wallet + Received Wallet (or one of each + a counterparty), making it the
cleanest possible source for the v2 model. We turn each row into a
single balanced transaction with two postings and route through
``ledger.post_transaction`` so the SUM=0 invariant catches any miswiring.

Mapping from CoinTracker wallets to our account_ids:

  1. If an Ethereum-shaped address is present → look up the matching
     ``zerion:<chain>:<address>`` account (exact address match).
  2. Wallet name starts with "Coinbase" → ``coinbase:exchange-bundle``.
     Coinbase reports per-asset sub-wallets, but for ledger purposes we
     bundle them: SimpleFIN only exposes current balances per
     sub-account, and the historical txn flow only makes sense as a
     single exchange aggregate.
  3. Wallet name starts with "Ledger" → ``wallet:ledger-cold`` /
     ``wallet:ledger-hot`` depending on substring.
  4. Wallet name is an ENS handle (``*.eth``) → ``wallet:<handle>``.
  5. Otherwise → ``equity:unknown-counterparty``. Logged as unmapped
     so the user can decide whether to add a mapping rule.

USD valuation: ``Received Cost Basis (USD)`` if non-zero, else
``Sent Cost Basis (USD)``. Both zero ⇒ raw_event recorded for audit
but no posting (no economic effect). Realized gains aren't booked as
postings — net worth is mark-to-market via balance_assertions, and
adding cost-basis vs market deltas here would drift from that.
"""

from __future__ import annotations

import csv
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .. import ledger


SYNTHETIC_ACCOUNTS = {
    "coinbase:exchange-bundle": ("Coinbase (CoinTracker bundle)", "Coinbase", "crypto"),
    "wallet:ledger-cold": ("Ledger Cold Wallet", "Ledger", "crypto"),
    "wallet:ledger-hot": ("Ledger Hot Wallet", "Ledger", "crypto"),
    "wallet:fiat-cash": ("Cash (off-system fiat)", "Cash", "checking"),
}


# Types that have no economic effect — same wallet, currency conversion only.
# We still record the raw_event for audit but don't write postings.
_INTRA_WALLET_TYPES = frozenset(
    {"TRADE", "MULTI_TOKEN_TRADE", "WRAP", "STAKE", "UNSTAKE",
     "ADD_LIQUIDITY", "REMOVE_LIQUIDITY",
     "BUY", "SELL"}
)
_SKIP_TYPES = frozenset({"SPAM"})
_INCOME_TYPES = frozenset(
    {"RECEIVE", "AIRDROP", "MINT", "INCOME", "OTHER_INCOME",
     "INTEREST_INCOME"}
)


@dataclass
class CointrackerStats:
    rows_total: int = 0
    rows_skipped: int = 0
    rows_posted: int = 0
    rows_zero_value: int = 0
    rows_already_ingested: int = 0
    unmapped_wallets: dict[str, int] = field(default_factory=dict)
    types_seen: dict[str, int] = field(default_factory=dict)


def _ensure_synthetic_accounts(conn: sqlite3.Connection) -> None:
    """Create the synthetic accounts CoinTracker rolls up to, if absent."""
    for acct_id, (name, inst, typ) in SYNTHETIC_ACCOUNTS.items():
        conn.execute(
            """
            INSERT OR IGNORE INTO accounts
              (id, display_name, institution, type, currency, active, mode)
            VALUES (?, ?, ?, ?, 'USD', 1, 'manual')
            """,
            (acct_id, name, inst, typ),
        )


def _build_address_index(
    conn: sqlite3.Connection,
) -> dict[str, str]:
    """Lowercase EVM address → zerion:<chain>:<address> account_id."""
    out: dict[str, str] = {}
    for (acct_id,) in conn.execute(
        "SELECT id FROM accounts WHERE id LIKE 'zerion:%' AND active = 1"
    ):
        # zerion:base:0x86d6441dcccc... → split off the address.
        parts = acct_id.split(":", 2)
        if len(parts) == 3:
            out.setdefault(parts[2].lower(), acct_id)
    return out


_ENS_RE = re.compile(r"^[a-z0-9_-]+\.eth\b", re.IGNORECASE)
_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _map_wallet(
    wallet_name: str,
    address: str,
    address_index: dict[str, str],
    stats: CointrackerStats,
) -> str:
    """Resolve a CoinTracker wallet name + address to one of our account_ids."""
    addr = (address or "").strip().lower()
    if _ADDRESS_RE.match(addr) and addr in address_index:
        return address_index[addr]

    name = (wallet_name or "").strip()
    name_l = name.lower()
    if not name and not addr:
        return ledger.UNKNOWN_COUNTERPARTY

    if name_l.startswith("coinbase"):
        # USD wallets on Coinbase are fiat-side; still bundle to the same
        # exchange account since fiat balance lives there.
        return "coinbase:exchange-bundle"
    if "ledger" in name_l and "cold" in name_l:
        return "wallet:ledger-cold"
    if "ledger" in name_l and ("hot" in name_l or name_l.endswith("ledger")):
        return "wallet:ledger-hot"
    if "ledger" in name_l:
        return "wallet:ledger-hot"
    if _ENS_RE.match(name):
        # Normalize "realitycrafter.eth (Ethereum)" → "realitycrafter.eth"
        ens = name_l.split(" ", 1)[0]
        return f"wallet:{ens}"

    # Unmapped — track for the report.
    key = name or addr
    stats.unmapped_wallets[key] = stats.unmapped_wallets.get(key, 0) + 1
    return ledger.UNKNOWN_COUNTERPARTY


def _parse_date(s: str) -> str | None:
    """CoinTracker dates: '04/14/2026 08:02:09' → '2026-04-14'."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s.split(" ", 1)[0], "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


def _f(s: str) -> float:
    s = (s or "").strip()
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _build_postings(
    row: dict[str, str],
    address_index: dict[str, str],
    stats: CointrackerStats,
) -> tuple[list[ledger.Posting], str] | None:
    """Return (postings, description) or None to skip this row."""
    typ = row.get("Type", "").strip().upper()
    if typ in _SKIP_TYPES:
        return None
    if typ in _INTRA_WALLET_TYPES:
        # Same-wallet currency conversion: no USD-balance effect.
        return None

    sent_usd = _f(row.get("Sent Cost Basis (USD)", ""))
    recv_usd = _f(row.get("Received Cost Basis (USD)", ""))
    usd = recv_usd if recv_usd > 0 else sent_usd
    if usd <= 0:
        stats.rows_zero_value += 1
        return None

    sent_acct = _map_wallet(
        row.get("Sent Wallet", ""), row.get("Sent Address", ""),
        address_index, stats,
    )
    recv_acct = _map_wallet(
        row.get("Received Wallet", ""), row.get("Received Address", ""),
        address_index, stats,
    )

    # Decide source / destination based on type.
    if typ == "BUY":
        # Fiat → crypto. Sent side is fiat; if not mapped, it's external cash.
        if sent_acct == ledger.UNKNOWN_COUNTERPARTY:
            sent_acct = "wallet:fiat-cash"
        src, dst = sent_acct, recv_acct
    elif typ == "SELL":
        if recv_acct == ledger.UNKNOWN_COUNTERPARTY:
            recv_acct = "wallet:fiat-cash"
        src, dst = sent_acct, recv_acct
    elif typ == "SEND":
        # Outflow to off-system address.
        src = sent_acct
        dst = ledger.UNKNOWN_COUNTERPARTY
    elif typ in _INCOME_TYPES:
        # Inflow from off-system / on-chain reward.
        src = ledger.UNKNOWN_COUNTERPARTY
        dst = recv_acct
    elif typ in ("TRANSFER", "BRIDGE"):
        src, dst = sent_acct, recv_acct
    else:
        # Unknown type — fall back to the most informative posting we can.
        if recv_acct == ledger.UNKNOWN_COUNTERPARTY:
            src, dst = sent_acct, ledger.UNKNOWN_COUNTERPARTY
        else:
            src, dst = sent_acct, recv_acct

    if src == dst:
        # No-op — same account on both sides.
        return None

    qty_field = row.get("Received Quantity") or row.get("Sent Quantity") or ""
    cur_field = row.get("Received Currency") or row.get("Sent Currency") or ""
    memo = f"{typ} {qty_field.strip()} {cur_field.strip()}".strip()
    desc = f"cointracker:{typ.lower()}"

    return (
        [
            ledger.Posting(account_id=src, amount=-usd, memo=memo),
            ledger.Posting(account_id=dst, amount=usd, memo=memo),
        ],
        desc,
    )


def parse(
    path: Path, conn: sqlite3.Connection
) -> CointrackerStats:
    stats = CointrackerStats()
    _ensure_synthetic_accounts(conn)
    address_index = _build_address_index(conn)

    with path.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stats.rows_total += 1
            typ = row.get("Type", "").strip().upper()
            stats.types_seen[typ] = stats.types_seen.get(typ, 0) + 1

            txn_id = row.get("Transaction ID", "").strip()
            if not txn_id:
                stats.rows_skipped += 1
                continue

            iso = _parse_date(row.get("Date", ""))
            if iso is None:
                stats.rows_skipped += 1
                continue

            raw_id = ledger.record_event(
                conn,
                source="cointracker",
                external_id=f"cointracker:{txn_id}",
                payload=row,
                source_file=path.name,
            )
            if raw_id is None:
                stats.rows_already_ingested += 1
                continue

            built = _build_postings(row, address_index, stats)
            if built is None:
                stats.rows_skipped += 1
                continue
            postings, desc = built

            ledger.post_transaction(
                conn,
                date=iso,
                description=desc,
                postings=postings,
                raw_ids=(raw_id,),
                derived_by="cointracker",
                category="Crypto",
                notes=row.get("Realized Return (USD)", "") or None,
            )
            stats.rows_posted += 1

    conn.commit()
    return stats


def print_stats(stats: CointrackerStats) -> None:
    print(f"  rows total:          {stats.rows_total}")
    print(f"  rows posted:         {stats.rows_posted}")
    print(f"  rows skipped:        {stats.rows_skipped}")
    print(f"  rows zero value:     {stats.rows_zero_value}")
    print(f"  rows already in DB:  {stats.rows_already_ingested}")
    if stats.unmapped_wallets:
        print(f"  unmapped wallets (top 10):")
        top = sorted(stats.unmapped_wallets.items(), key=lambda x: -x[1])[:10]
        for name, n in top:
            print(f"    {n:>5}  {name[:80]}")
    print(f"  types seen:")
    for t, n in sorted(stats.types_seen.items(), key=lambda x: -x[1]):
        print(f"    {n:>5}  {t}")
