"""Chase monthly-statement PDF parser.

Chase's online CSV/QFX export caps at ~24 months, but the Statements
tab archives roughly 7 years of monthly PDFs. Each statement has a
``*start*transaction detail`` / ``*end*transaction detail`` block with
rows like::

    12/21 Coinbase Inc. 8889087930 PPD ID: 1327000623  5,000.00  6,937.25
    01/14 Gusto Pay 486986 PPD ID: 9138864001          2,016.67  9,210.45

Dates are MM/DD only — the year is resolved from the statement period
printed on page 1 (``December 21, 2021through January 21, 2022``).

Produces ``ChaseStatement`` objects (same shape as the CSV/QFX parser)
so the existing ``ingest_chase_statements()`` pipeline picks them up
without changes.
"""

from __future__ import annotations

import hashlib
import re
from datetime import date as _date, datetime
from pathlib import Path

import pdfplumber

from .base import TransactionRow
from .chase_ofx import ChaseStatement


_TXN_BLOCK_RE = re.compile(
    r"\*start\*transaction\s+detail(.+?)\*end\*transaction\s+detail",
    re.IGNORECASE | re.DOTALL,
)
# Each row: MM/DD [optional date] DESCRIPTION signed-amount running-balance
# Amounts may have commas; credit-card statements sometimes show the amount
# without a running balance. We accept either.
_TXN_ROW_RE = re.compile(
    r"^(\d{2}/\d{2})\s+"
    r"(.+?)\s+"
    r"(-?[\d,]+\.\d{2})"
    r"(?:\s+(-?[\d,]+\.\d{2}))?\s*$"
)
_PERIOD_RE = re.compile(
    r"([A-Za-z]+\s+\d{1,2}),?\s*(\d{4})\s*through\s*"
    r"([A-Za-z]+\s+\d{1,2}),?\s*(\d{4})",
    re.IGNORECASE,
)
# "Beginning Balance $1,937.25" and "Ending Balance $3,653.42" in the
# CHECKING SUMMARY block.
_BEGIN_BAL_RE = re.compile(
    r"Beginning\s+Balance\s+\$?(-?[\d,]+\.\d{2})", re.IGNORECASE
)
_END_BAL_RE = re.compile(
    r"Ending\s+Balance\s+\$?(-?[\d,]+\.\d{2})", re.IGNORECASE
)
# Checking: "Account Number: 000000684608166" → 8166
# Credit:   "Account Number: XXXX XXXX XXXX 7800" → 7800
_ACCT_SUFFIX_RE = re.compile(
    r"Account\s+Number:\s*(?:X{4}\s+)*X*\s*(\d{4,5})\b",
    re.IGNORECASE,
)
# Fallback: the statement filename includes the suffix.
_FILE_SUFFIX_RE = re.compile(r"(\d{3,5})-?\.pdf$", re.IGNORECASE)


def _parse_money(s: str) -> float | None:
    try:
        return float(s.replace(",", ""))
    except (TypeError, ValueError):
        return None


def _resolve_year(md: str, start: _date, end: _date) -> str | None:
    """Given a `MM/DD` string plus the statement's start/end dates,
    figure out which year the txn belongs to."""
    try:
        m, d = md.split("/")
        mi, di = int(m), int(d)
    except (ValueError, AttributeError):
        return None
    # Prefer start year when the month is in the first half of the period;
    # otherwise use end year. Handles end-of-year wrap.
    if start.year == end.year:
        return f"{start.year:04d}-{mi:02d}-{di:02d}"
    # Period crosses year boundary (e.g., Dec → Jan). Month>= start.month
    # and month <=12 belongs to start year; month <= end.month belongs to
    # end year.
    if mi >= start.month:
        y = start.year
    else:
        y = end.year
    try:
        return f"{y:04d}-{mi:02d}-{di:02d}"
    except ValueError:
        return None


def _extract_period(text: str) -> tuple[_date, _date] | None:
    m = _PERIOD_RE.search(text)
    if not m:
        return None
    try:
        start = datetime.strptime(f"{m.group(1)} {m.group(2)}", "%B %d %Y").date()
        end = datetime.strptime(f"{m.group(3)} {m.group(4)}", "%B %d %Y").date()
        return start, end
    except ValueError:
        return None


def _extract_acctid(text: str, fallback_name: str) -> str | None:
    m = _ACCT_SUFFIX_RE.search(text)
    if m:
        return m.group(1)
    m2 = _FILE_SUFFIX_RE.search(fallback_name)
    if m2:
        return m2.group(1)
    return None


def parse(path: Path) -> ChaseStatement | None:
    """Parse one Chase monthly statement PDF. Returns None if we can't
    find transactions (cover page only, or atypical layout)."""
    with pdfplumber.open(str(path)) as pdf:
        full = "\n".join((page.extract_text() or "") for page in pdf.pages)

    period = _extract_period(full)
    if not period:
        return None
    start, end = period
    acctid = _extract_acctid(full, path.name)
    if not acctid:
        return None

    txns: list[TransactionRow] = []
    # There may be several transaction-detail blocks (ATM, Electronic, etc.
    # — Chase sometimes splits them). Capture every one.
    for block_match in _TXN_BLOCK_RE.finditer(full):
        block = block_match.group(1)
        for raw_line in block.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            row = _TXN_ROW_RE.match(line)
            if not row:
                continue
            md, desc, amt_str, _bal = row.groups()
            iso = _resolve_year(md, start, end)
            amt = _parse_money(amt_str)
            if not iso or amt is None:
                continue
            desc = desc.strip()
            # Stable id: acct + date + amount + description hash. PDF rows
            # lack FITIDs, so dedup via content hash is the only option.
            key = f"{acctid}|{iso}|{amt:.2f}|{desc}"
            fitid = hashlib.sha1(key.encode()).hexdigest()[:16]
            txns.append(
                TransactionRow(
                    id=f"chase:{acctid}:pdf:{fitid}",
                    account_id="",
                    date=iso,
                    amount=amt,
                    description=desc or "(unknown)",
                    source_file=path.name,
                    payee=desc or None,
                )
            )

    # Balance anchors from the statement's summary block. Beginning
    # balance is as-of the period start; ending balance as-of the end.
    # These are the real source of truth for historical reconstruction.
    anchors: list[tuple[str, float]] = []
    bm = _BEGIN_BAL_RE.search(full)
    em = _END_BAL_RE.search(full)
    if bm:
        v = _parse_money(bm.group(1))
        if v is not None:
            anchors.append((start.isoformat(), v))
    if em:
        v = _parse_money(em.group(1))
        if v is not None:
            anchors.append((end.isoformat(), v))

    return ChaseStatement(
        acctid=acctid,
        txns=txns,
        source_file=path.name,
        balance_anchors=anchors,
    )
