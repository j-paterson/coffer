"""Kubera snapshot parser.

A Kubera snapshot is a folder containing Financial.csv — a full account
export. The companion Cashflow.csv used to be parsed too (deposit/withdraw
rows for manually-tracked assets) but the v1 investment_txns table that
consumed it was retired in migration 046; cashflow comes from postings now.

Folder naming convention: raw/kubera/YYYY-MM-DD/ — the date becomes the
`as_of` for all balances and holdings produced.
"""
from __future__ import annotations

import csv
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from .base import (
    AccountRow,
    BalanceRow,
    HoldingRow,
    ParseResult,
)


def _parse_float(v: Optional[str]) -> Optional[float]:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    try:
        return float(v.replace(",", ""))
    except ValueError:
        return None


def _infer_account_type(category: str, sheet: str, section: str) -> str:
    category = (category or "").lower()
    sheet = (sheet or "").lower().strip()
    section = (section or "").lower().strip()
    if category == "debt":
        return "credit"
    if sheet == "cash":
        if "saving" in section:
            return "savings"
        return "checking"
    if sheet == "investments":
        if section == "securities":
            return "brokerage"
        if section == "retirement":
            return "retirement"
        return "alt"
    if sheet == "tokens":
        return "crypto"
    return "manual"


def _parse_active(status: str) -> int:
    if not status:
        return 1
    return 0 if status.strip().lower().startswith("archived") else 1


def _pick_institution(row: dict) -> str:
    for key in ("Provider Name", "Parent Provider Name", "Parent Account Name"):
        v = (row.get(key) or "").strip()
        if v:
            return v
    # Crypto sections often have neither provider; use the wallet grouping.
    v = (row.get("Section Name") or "").strip()
    if v:
        return v
    return "Unknown"


def _extract_snapshot_date(folder: Path) -> str:
    m = re.match(r"(\d{4}-\d{2}-\d{2})", folder.name)
    if m:
        return m.group(1)
    return datetime.now().strftime("%Y-%m-%d")


def _read_financial_csv(path: Path) -> list[dict]:
    """Skip Kubera's preamble lines and return dict rows from the main table."""
    with path.open(newline="", encoding="utf-8") as f:
        lines = f.readlines()
    header_idx = next(
        (i for i, line in enumerate(lines) if line.startswith("Name,Category,")),
        0,
    )
    reader = csv.DictReader(lines[header_idx:])
    return list(reader)


def parse(folder: Path, project_root: Optional[Path] = None) -> ParseResult:
    """Parse a Kubera snapshot folder into a ParseResult."""
    result = ParseResult()
    as_of = _extract_snapshot_date(folder)
    project_root = project_root or folder.parents[2]

    financial_path = folder / "Financial.csv"

    if not financial_path.exists():
        result.warnings.append(f"missing {financial_path}")
        return result

    rows = _read_financial_csv(financial_path)

    accounts_by_id: dict[str, AccountRow] = {}

    # Two passes: first establish all top-level accounts, then attach
    # sub-asset breakdowns as holdings on their parent. Guards against FK
    # errors when a breakdown row precedes its parent in the CSV.
    top_level_ids: set[str] = set()
    for row in rows:
        kid = (row.get("Id") or "").strip()
        if kid and not (row.get("Parent Id") or "").strip():
            top_level_ids.add(f"kubera:{kid}")

    for row in rows:
        kid = (row.get("Id") or "").strip()
        if not kid:
            continue

        name = (row.get("Name") or "").strip() or "(unnamed)"
        category = (row.get("Category") or "").strip()
        sheet = (row.get("Sheet Name") or "").strip()
        section = (row.get("Section Name") or "").strip()
        currency = (row.get("Asset Currency") or "").strip() or "USD"
        status = (row.get("Status") or "").strip()
        ticker = (row.get("Ticker") or "").strip()
        value_usd = _parse_float(row.get("Value (USD)"))
        quantity = _parse_float(row.get("Quantity"))
        cost = _parse_float(row.get("Cost"))
        asset_class = (row.get("Asset Class") or "").strip() or None
        parent_id = (row.get("Parent Id") or "").strip()
        # Sub-asset rows (e.g. "ETH" inside "Ethereum Vault") report value
        # that's already aggregated into the parent's total. Treat them as
        # holdings of the parent, not standalone accounts. Otherwise pad
        # would double-count: parent assertion + sub-asset assertion.
        is_breakdown = bool(parent_id)
        host_acct_id = f"kubera:{parent_id}" if parent_id else f"kubera:{kid}"

        acct_type = _infer_account_type(category, sheet, section)
        active = _parse_active(status)
        institution = _pick_institution(row)

        if not is_breakdown and host_acct_id not in accounts_by_id:
            accounts_by_id[host_acct_id] = AccountRow(
                id=host_acct_id,
                display_name=name,
                institution=institution,
                type=acct_type,
                currency=currency,
                active=active,
                mode="manual",  # Kubera-imported = stale placeholder data
            )

        # Sign convention: assets positive, debts negative. Kubera's CSV stores
        # debts as positive (amount owed) — we flip on ingest to match SimpleFIN
        # and the rest of the system.
        if value_usd is not None and not is_breakdown:
            signed_value = -value_usd if acct_type == "credit" else value_usd
            result.balances.append(
                BalanceRow(
                    account_id=host_acct_id,
                    as_of=as_of,
                    value_usd=signed_value,
                    source="kubera",
                )
            )

        if ticker and value_usd is not None and (
            not is_breakdown or host_acct_id in top_level_ids
        ):
            # Use the breakdown's own ticker/qty/value, but attach to the
            # PARENT account so the holdings UI shows the breakdown beneath
            # its host wallet. Skip if the parent isn't a top-level account
            # we know about (would FK-fail).
            result.holdings.append(
                HoldingRow(
                    account_id=host_acct_id,
                    as_of=as_of,
                    symbol=ticker if not is_breakdown else (ticker or name),
                    asset_class=asset_class,
                    quantity=quantity,
                    value_usd=value_usd,
                    cost_basis=cost,
                )
            )

    result.accounts = list(accounts_by_id.values())

    return result
