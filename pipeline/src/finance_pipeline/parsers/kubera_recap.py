"""Kubera quarterly recap CSV parser.

Kubera exports a "Recap Investable Assets / Quarterly / Totals (USD)"
CSV that contains ground-truth per-asset USD snapshots on quarter-end
dates (Q1/Q2/Q3/Q4 + current as-of), going back to the earliest
connection date. Every row is one asset/holding; every column (after
the first two) is a date.

We turn every (asset, date) cell with a non-zero value into a
``balance_assertion`` on the matching account — the cleanest possible
anchor for net-worth reconstruction, since Kubera aggregates across all
providers with its own reconciliation.

Asset name → account_id matching uses the digit suffix embedded in the
name (e.g. "Chase - Checking - 8166" → any account whose id / display
name contains "8166"). Unmapped assets are reported so the user can
decide whether to wire them up.
"""

from __future__ import annotations

import csv
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .. import ledger


@dataclass
class KuberaRecapStats:
    rows_total: int = 0
    rows_matched: int = 0
    assertions_written: int = 0
    unmapped_assets: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return {
            "rows_total": self.rows_total,
            "rows_matched": self.rows_matched,
            "assertions_written": self.assertions_written,
            "unmapped_assets_count": len(self.unmapped_assets),
        }


def _parse_date(header_cell: str) -> str | None:
    """Kubera's header dates look like '14 Apr 2026' — return ISO."""
    s = (header_cell or "").strip()
    try:
        return datetime.strptime(s, "%d %b %Y").date().isoformat()
    except ValueError:
        return None


def _parse_amount(cell: str) -> float | None:
    s = (cell or "").strip().replace(",", "")
    if not s or s == "0":
        # zero is meaningful as "account existed but was empty" — don't
        # drop it on the floor. Return 0.0 distinct from None.
        return 0.0 if s == "0" else None
    try:
        return float(s)
    except ValueError:
        return None


_STOP_WORDS = {
    "the", "a", "an", "and", "or", "of", "for", "in", "to", "by",
    "wallet", "account", "card", "cash", "bank", "credit", "checking",
    "savings", "investment", "investments", "individual", "primary",
    "personal", "shared", "rewards", "signature", "platinum", "gold",
    "active", "manual", "live", "preferred", "hot", "cold",
}


def _tokens(s: str) -> set[str]:
    """Distinctive lowercase word tokens from a name (≥4 chars, non-stop)."""
    return {
        w for w in re.findall(r"[a-zA-Z]+", (s or "").lower())
        if len(w) >= 4 and w not in _STOP_WORDS
    }


def _strip_id_noise(name: str) -> str:
    """Strip parenthesized account identifiers/UUIDs from a display name.
    "PRIME Wallet (ace91fad-9e98-...)" → "PRIME Wallet" so a recap row
    like "ACE • Ace" doesn't match the literal "ace" inside the UUID."""
    return re.sub(r"\s*\([^)]*\)\s*", " ", name or "").strip()


def _build_account_index(
    conn: sqlite3.Connection,
) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """Return (suffix→account_id map, list of (id, display_name) for
    substring fallback). The display-name list includes BOTH canonical
    accounts and merged aliases — when the recap row says "Vanguard
    Roth IRA" we want to find it via the kubera alias's display name
    even though the canonical (simplefin Roth IRA) doesn't carry the
    word "Vanguard". The map returns the canonical id either way."""
    suffix_map: dict[str, str] = {}
    name_index: list[tuple[str, str]] = []
    rows = conn.execute(
        """SELECT id, COALESCE(display_name_override, display_name),
                  COALESCE(merged_into, id) AS canonical
           FROM accounts WHERE active = 1"""
    ).fetchall()
    for acct_id, name, canonical in rows:
        for m in re.finditer(r"\((\d{3,})\)|(\d{4,})\b", name or ""):
            digits = m.group(1) or m.group(2)
            if digits and digits not in suffix_map:
                suffix_map[digits] = canonical
        if name:
            name_index.append((canonical, _strip_id_noise(name)))
    return suffix_map, name_index


# Class names that are aggregates, not individual accounts — skip these.
_CATEGORY_NAMES = {
    "investable assets",
    "cash",
    "stocks",
    "crypto",
    "funds",
    "private investments",
    "alternatives",
    "real estate",
    "retirement",
    "bonds",
    "precious metals",
}


def _candidates(asset_name: str) -> list[str]:
    """Generate progressively-stripped name candidates for a recap row.
    Recap row formats:
      Cash:           "<Account Name> - <Sub-Asset>"
      Stocks/CashEq:  "<TICKER>.NA • <Fund Name> (allocation%)"
      Crypto:         "<TICKER> • <Token Name>"
    The full row name rarely matches an account directly, but its
    parent-account prefix (before the first ` - `) usually does."""
    s = (asset_name or "").strip()
    if not s:
        return []
    out = [s]
    # Prefix before " - " (Cash section: "<Account> - <Detail>").
    if " - " in s:
        out.append(s.split(" - ", 1)[0].strip())
    # After "•" (Stocks/Crypto: "<TICKER> • <Name>"). Drop trailing
    # parenthetical allocation hint.
    if "•" in s:
        tail = s.split("•", 1)[1].strip()
        tail = re.sub(r"\s*\([^)]*\)\s*$", "", tail).strip()
        if tail:
            out.append(tail)
        # Also try the ticker alone (before the dot if "TICKER.NA" form).
        head = s.split("•", 1)[0].strip()
        if head:
            out.append(head.split(".", 1)[0].strip())
    return [c for c in out if c]


def _match_account(
    asset_name: str,
    suffix_map: dict[str, str],
    all_accounts: list[tuple[str, str]],
) -> str | None:
    if not asset_name:
        return None
    name_l = asset_name.lower().strip()
    if name_l in _CATEGORY_NAMES:
        return None
    # 1. Suffix match on any digit run in the full name.
    for m in re.finditer(r"\((\d{3,})\)|\b(\d{4,})\b", asset_name):
        digits = m.group(1) or m.group(2)
        if digits in suffix_map:
            return suffix_map[digits]
    # 2. Substring match — try full name, then progressive strips
    #    (parent prefix, ticker, fund name without allocation suffix).
    #    Require ≥4 chars to avoid spurious 3-letter ticker matches like
    #    "ACE", "DOG" colliding with random substrings of display names.
    for cand in _candidates(asset_name):
        cl = cand.lower()
        if len(cl) < 4:
            continue
        for acct_id, disp in all_accounts:
            dl = (disp or "").lower()
            if not dl or len(dl) < 4:
                continue
            if dl == cl or dl in cl or cl in dl:
                return acct_id
    # 3. Distinctive-token uniqueness. Build {token → set of account_ids}
    #    once-per-call from all_accounts, then look for any candidate-token
    #    that appears in EXACTLY ONE account. This catches "VTSAX • Vanguard
    #    Total Stock Mkt Idx Adm" → the only "Vanguard"-tokened account
    #    (Roth IRA via its kubera alias). Common words like "Schwab" that
    #    appear in multiple accounts won't trigger.
    token_owners: dict[str, set[str]] = {}
    for acct_id, disp in all_accounts:
        for t in _tokens(disp):
            token_owners.setdefault(t, set()).add(acct_id)
    for cand in _candidates(asset_name):
        for t in _tokens(cand):
            owners = token_owners.get(t)
            if owners and len(owners) == 1:
                return next(iter(owners))
    return None


def parse(
    path: Path, conn: sqlite3.Connection
) -> KuberaRecapStats:
    stats = KuberaRecapStats()
    suffix_map, all_accounts = _build_account_index(conn)
    # Account type lookup so credit-card values (Kubera stores
    # amount-owed as positive) get sign-flipped at write time. Matches
    # the convention in kubera.py for the Financial.json parser.
    type_by_id = dict(
        conn.execute(
            "SELECT id, type FROM accounts WHERE active = 1"
        ).fetchall()
    )

    with path.open(encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        rows = list(reader)
    if len(rows) < 3:
        return stats
    # rows[0] = title; rows[1] = header with dates; rest = data
    header = rows[1]
    date_cols: list[tuple[int, str]] = []
    for i, cell in enumerate(header[2:], start=2):
        iso = _parse_date(cell)
        if iso:
            date_cols.append((i, iso))

    # Multiple recap rows may map to the same canonical account (e.g.
    # VTSAX + VTIAX + Money Market all → Vanguard Roth IRA). Aggregate
    # by (account_id, date) before writing balance assertions so we
    # don't lose values to last-write-wins on the (account, date,
    # source) primary key.
    aggregated: dict[tuple[str, str], float] = {}
    contributing: dict[str, list[str]] = {}

    for row in rows[2:]:
        if not row or len(row) < 3:
            continue
        asset_name = row[0].strip()
        if not asset_name or asset_name.lower() in _CATEGORY_NAMES:
            continue
        stats.rows_total += 1
        account_id = _match_account(asset_name, suffix_map, all_accounts)
        if not account_id:
            cur_val = _parse_amount(row[date_cols[0][0]]) if date_cols else 0.0
            stats.unmapped_assets[asset_name] = cur_val or 0.0
            continue
        stats.rows_matched += 1
        contributing.setdefault(account_id, []).append(asset_name)

        for col_idx, iso in date_cols:
            if col_idx >= len(row):
                continue
            v = _parse_amount(row[col_idx])
            if v is None:
                continue
            # Credit cards: Kubera stores debt as positive amount-owed.
            # Flip to match the system convention (debt = negative).
            if type_by_id.get(account_id) == "credit":
                v = -v
            aggregated[(account_id, iso)] = (
                aggregated.get((account_id, iso), 0.0) + v
            )

    # Single raw_event per matched account capturing every contributing
    # row name — useful to trace back which recap rows summed to one
    # assertion.
    for account_id, names in contributing.items():
        ledger.record_event(
            conn,
            source="kubera-recap",
            external_id=f"{account_id}|{path.name}",
            payload={"contributing_rows": names, "file": path.name},
            source_file=path.name,
        )

    for (account_id, iso), v in aggregated.items():
        ledger.assert_balance(
            conn,
            account_id=account_id,
            as_of=iso,
            expected_usd=v,
            source="kubera-recap",
            source_file=path.name,
        )
        stats.assertions_written += 1
    conn.commit()
    return stats


def print_stats(stats: KuberaRecapStats) -> None:
    print(f"  rows in CSV:         {stats.rows_total}")
    print(f"  matched to accounts: {stats.rows_matched}")
    print(f"  assertions written:  {stats.assertions_written}")
    if stats.unmapped_assets:
        print(f"  unmapped (top 10 by current value):")
        top = sorted(stats.unmapped_assets.items(), key=lambda x: -x[1])[:10]
        for name, v in top:
            print(f"    ${v:>11,.2f}  {name[:70]}")
