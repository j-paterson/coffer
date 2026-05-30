"""Chase OFX / QFX / CSV statement parser.

Chase exposes only ~90 days of transactions through SimpleFIN, but their
website lets you download up to ~7 years per account as OFX/QFX (checking,
savings, credit) or CSV. This parser converts those downloads into the
same `TransactionRow` shape our ingest pipeline already understands, so
we can stretch the net-worth history backward to whatever statements the
user has saved.

Account matching is deferred — the parser returns raw txns tagged with
the source ACCTID; `ingest.ingest_chase_statements()` maps those to our
SimpleFIN account IDs and writes them.

Dedup key: ``chase:<acctid>:<fitid>`` for OFX (FITID is stable across
re-downloads). CSV lacks a stable ID, so we fall back to a hash of
date+amount+description — good enough because Chase's CSV rarely exposes
true duplicates.
"""

from __future__ import annotations

import csv
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypedDict


class CsvLayout(TypedDict, total=False):
    provider: str        # required
    signature: str       # required — lowercase column that identifies layout
    date: str            # required — column name for transaction date
    desc: str            # required — column name for description
    amount: str          # amount column (single)
    withdrawal: str      # Schwab split: debit column
    deposit: str         # Schwab split: credit column
    memo: str            # optional memo/action column
    status_col: str      # optional filter column
    posted_value: str    # value in status_col that means "posted"

from .base import ParseResult, TransactionRow


@dataclass
class ChaseStatement:
    """A parser's-eye view of one statement file — a list of txns all
    belonging to one Chase account, tagged with its raw ACCTID so ingest
    can resolve it to one of our SimpleFIN account rows.

    PDF parsers additionally populate ``balance_anchors`` with
    (date, USD) pairs taken from the statement's "Beginning Balance"
    and "Ending Balance" summary — authoritative snapshots used by the
    networth walker to avoid flat-lining historical reconstructions.
    """
    acctid: str
    txns: list[TransactionRow]
    source_file: str
    balance_anchors: list[tuple[str, float]] = field(default_factory=list)


_TAG_RE = re.compile(r"<([A-Z0-9]+)>([^<\r\n]*)")
_STMTTRN_RE = re.compile(r"<STMTTRN>(.*?)</STMTTRN>", re.DOTALL)
_ACCTID_RE = re.compile(r"<ACCTID>\s*([^<\r\n]+)")


def _ofx_field(block: str, tag: str) -> str | None:
    m = re.search(rf"<{tag}>([^<\r\n]*)", block)
    return m.group(1).strip() if m else None


def _ofx_date(s: str) -> str | None:
    """OFX DTPOSTED: YYYYMMDDHHMMSS[Z[-offset]]. Return ISO date."""
    s = (s or "").strip()
    if len(s) < 8 or not s[:8].isdigit():
        return None
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def parse_ofx(path: Path) -> ChaseStatement | None:
    """Parse one OFX/QFX file. Returns None if the file has no ACCTID."""
    txt = path.read_text(encoding="utf-8", errors="replace")
    acct_m = _ACCTID_RE.search(txt)
    if not acct_m:
        return None
    acctid = acct_m.group(1).strip()

    txns: list[TransactionRow] = []
    for stmt_m in _STMTTRN_RE.finditer(txt):
        block = stmt_m.group(1)
        fitid = _ofx_field(block, "FITID")
        dt = _ofx_date(_ofx_field(block, "DTPOSTED") or "")
        amt_str = _ofx_field(block, "TRNAMT")
        if not (fitid and dt and amt_str):
            continue
        try:
            amt = float(amt_str)
        except ValueError:
            continue
        name = (_ofx_field(block, "NAME") or "").strip()
        memo = (_ofx_field(block, "MEMO") or "").strip()
        description = " — ".join(p for p in (name, memo) if p) or "(unknown)"
        txns.append(
            TransactionRow(
                id=f"chase:{acctid}:{fitid}",
                account_id="",  # resolved in ingest
                date=dt,
                amount=amt,
                description=description,
                source_file=path.name,
                payee=name or None,
                memo=memo or None,
            )
        )
    return ChaseStatement(acctid=acctid, txns=txns, source_file=path.name)


# Each layout describes how to pull (date, description, amount, memo)
# out of one institution's CSV export. `signature` is a lowercase column
# header that must be present for the layout to apply. `provider` is a
# short tag used in the synthetic txn id prefix to keep IDs unique across
# providers. `status_col` / `posted_value` (optional) filters out
# pending rows.
_CSV_LAYOUTS: list[CsvLayout] = [
    # Chase checking/savings
    {
        "provider": "chase",
        "signature": "posting date",
        "date": "Posting Date",
        "desc": "Description",
        "amount": "Amount",
    },
    # Chase credit card
    {
        "provider": "chase",
        "signature": "transaction date",
        "date": "Transaction Date",
        "desc": "Description",
        "amount": "Amount",
        "memo": "Memo",
    },
    # Schwab checking (Withdrawal / Deposit split columns, Status filter)
    {
        "provider": "schwab",
        "signature": "runningbalance",
        "date": "Date",
        "desc": "Description",
        "withdrawal": "Withdrawal",
        "deposit": "Deposit",
        "status_col": "Status",
        "posted_value": "Posted",
    },
    # Schwab brokerage / IRA
    {
        "provider": "schwab",
        "signature": "action",
        "date": "Date",
        "desc": "Description",
        "amount": "Amount",
        "memo": "Action",
    },
    # Wealthfront Cash / Investment
    {
        "provider": "wealthfront",
        "signature": "transaction date",
        "date": "Transaction date",
        "desc": "Description",
        "amount": "Amount",
        "memo": "Type",
    },
]


def _money(s: str) -> float | None:
    """Parse Schwab/Wealthfront-style money strings: '$1,234.56', '-$123',
    '(450.00)'. Returns None on blank/unparseable."""
    s = (s or "").strip()
    if not s:
        return None
    s = s.replace("$", "").replace(",", "")
    # parenthesized negative
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return float(s)
    except ValueError:
        return None


def _pick_layout(headers: list[str]) -> CsvLayout | None:
    """Choose the most specific layout for a given header set. We iterate
    layouts in order and pick the first whose signature column is
    present; Chase's 'transaction date' also appears in Wealthfront's
    header ('Transaction date'), so more-specific layouts (unique
    columns like 'runningbalance' or 'action') come first in the list."""
    headers_lower = [h.lower() for h in headers]
    # Try specific-signature layouts first.
    for L in _CSV_LAYOUTS:
        sig = str(L["signature"]).lower()
        if sig in headers_lower:
            # Extra disambiguation: Wealthfront uses 'Transaction date'
            # (space) while Chase CC uses 'Transaction Date'. Both
            # lowercase the same. Distinguish by presence of 'post date'
            # (Chase) vs absence (Wealthfront).
            if sig == "transaction date":
                has_post_date = any("post date" in h for h in headers_lower)
                if L["provider"] == "chase" and not has_post_date:
                    continue
                if L["provider"] == "wealthfront" and has_post_date:
                    continue
            return L
    return None


def parse_csv(path: Path, acctid: str) -> ChaseStatement:
    """Parse any supported CSV layout. ``acctid`` is supplied by the
    caller (derived from filename or prompt)."""
    txns: list[TransactionRow] = []
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            return ChaseStatement(acctid=acctid, txns=[], source_file=path.name)
        layout = _pick_layout(list(reader.fieldnames))
        if layout is None:
            raise ValueError(
                f"Unrecognized CSV headers in {path.name}: {reader.fieldnames}"
            )
        provider = str(layout["provider"])
        for row in reader:
            # Status filter (Schwab checking only posts Posted rows).
            status_col = layout.get("status_col")
            if status_col and row.get(status_col, "") != layout.get("posted_value", ""):
                continue
            date = _parse_csv_date(row.get(layout["date"], ""))
            desc = (row.get(layout["desc"], "") or "").strip()
            memo_col = layout.get("memo")
            memo = (row.get(memo_col, "") if memo_col else "").strip()

            # Amount: layouts either expose a single column ("amount")
            # or a split pair ("withdrawal" / "deposit").
            if "amount" in layout:
                amt = _money(row.get(layout["amount"], ""))
            else:
                w = _money(row.get(layout["withdrawal"], "")) or 0.0
                d = _money(row.get(layout["deposit"], "")) or 0.0
                amt = d - w
            if not date or amt is None or amt == 0.0:
                continue

            key = f"{date}|{amt}|{desc}|{memo}"
            fitid = hashlib.sha1(key.encode()).hexdigest()[:16]
            txns.append(
                TransactionRow(
                    id=f"{provider}:{acctid}:csv:{fitid}",
                    account_id="",
                    date=date,
                    amount=amt,
                    description=desc or memo or "(unknown)",
                    source_file=path.name,
                    payee=desc or None,
                    memo=memo or None,
                )
            )
    return ChaseStatement(acctid=acctid, txns=txns, source_file=path.name)


def _parse_csv_date(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    # Schwab sometimes tags settlement dates: "05/16/2025 as of 05/15/2025"
    # Prefer the first date token.
    head = s.split(" as of ")[0].strip()
    # MM/DD/YYYY or M/D/YY(YY)
    parts = head.split("/")
    if len(parts) == 3:
        m, d, y = parts
        if len(y) == 2:
            y = "20" + y
        try:
            return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
        except ValueError:
            return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", head):
        return head
    return None


def parse_statement(path: Path, acctid_override: str | None = None) -> ChaseStatement | None:
    """Dispatch to the right parser based on extension.

    - .ofx / .qfx: ACCTID is embedded
    - .csv: caller must supply acctid_override (usually via filename)
    """
    suffix = path.suffix.lower()
    if suffix in (".ofx", ".qfx"):
        return parse_ofx(path)
    if suffix == ".csv":
        if not acctid_override:
            return None
        return parse_csv(path, acctid_override)
    return None


# Filename convention for CSVs that aren't manually tagged. Prefer a
# digit group that sits right after the institution prefix
# (e.g. "Chase8166_...", "Schwab595_...", "Wealthfront5006_...") so we
# don't accidentally grab an 8-digit trailing timestamp.
_CSV_LEADING_DIGITS_RE = re.compile(r"^[A-Za-z]+(\d{3,})", re.IGNORECASE)
_CSV_TRAILING_DIGITS_RE = re.compile(r"(\d{3,})(?:\D.*)?\.csv$", re.IGNORECASE)


def acctid_from_filename(name: str) -> str | None:
    m = _CSV_LEADING_DIGITS_RE.match(name)
    if m:
        return m.group(1)
    m = _CSV_TRAILING_DIGITS_RE.search(name)
    return m.group(1) if m else None


def build_result(stmts: list[ChaseStatement]) -> ParseResult:
    """Flatten a list of ChaseStatement into a ParseResult for ingest."""
    result = ParseResult()
    for s in stmts:
        result.transactions.extend(s.txns)
    return result
