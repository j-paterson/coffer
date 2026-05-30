"""Masterworks K-1 PDF parser.

Each K-1 is a Schedule K-1 (Form 1065) filed by one Masterworks LLC
(e.g., MW036, MW058) reporting the user's capital account for a given
tax year. The "Capital Account Analysis" (Box L, Part II) contains:

  Beginning capital account
  Capital contributed during the year
  Current year net income (loss)
  Other increase (decrease)
  Withdrawals and distributions
  Ending capital account            <-- what we anchor on

Multiple K-1s per PDF (one per LLC the user holds shares in). We sum
the *ending capital account* across all K-1s in a PDF and emit a single
balance assertion on the canonical Masterworks account at the year-end
date, since the user views Masterworks as a single position.

The tax year comes from the filename (e.g., 2024_MW058_K1.pdf →
2024-12-31). PDFs are flattened (no AcroForm fields), so we find values
by their position relative to the Box L row labels.

Currently Box L values land in the rightmost numeric column at
x≈230-260 across these specific Masterworks PDF templates. If the
template changes, the position heuristic may need to retune.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .. import ledger


# Canonical Masterworks account id. This is the kubera-imported
# Masterworks.io account; assertions land here so they roll up with
# Kubera snapshots.
MASTERWORKS_ACCOUNT_ID = "kubera:a5e6bd41-1a66-4e35-84fe-e348d84ecb21"


@dataclass
class K1Stats:
    files_parsed: int = 0
    k1s_found: int = 0
    assertions_written: int = 0
    yearly_totals: dict[str, float] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)


def _money(s: str) -> float | None:
    s = s.strip().replace(",", "").replace("$", "").rstrip(".")
    if not s:
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1]
    elif s.startswith("-"):
        neg = True
        s = s[1:]
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


# Approximate y-distance allowed between a row label and its value
# (PDF text extraction returns row positions per character; values
# usually share the same row within ±2 units).
_ROW_TOLERANCE = 4
# Box L values sit in the right numeric column; reject anything outside
# this x-band so we don't pick up unrelated form text.
_VALUE_X_MIN = 200
_VALUE_X_MAX = 305


def _ending_capital_for_page(page) -> float | None:
    """Find Box L "Ending capital account" value on one K-1 page."""
    words = page.extract_words()
    # Locate label row: "Ending capital account" — these three words
    # appear consecutively at x≈61-130 within Box L (lower half of page).
    # There can be multiple "Ending" tokens (Box L + Box N "Ending"), so
    # we additionally require "capital" + "account" within a few units
    # to the right on the same row.
    for w in words:
        if w["text"] != "Ending":
            continue
        same_row = [
            x for x in words
            if abs(x["top"] - w["top"]) <= _ROW_TOLERANCE
        ]
        labels = " ".join(
            x["text"] for x in sorted(same_row, key=lambda x: x["x0"])
        ).lower()
        if "ending capital account" not in labels:
            continue
        # Found the Box L Ending row. Pull the value in the right column.
        for x in sorted(same_row, key=lambda x: -x["x0"]):
            if _VALUE_X_MIN <= x["x0"] <= _VALUE_X_MAX:
                v = _money(x["text"])
                if v is not None:
                    return v
        return None
    return None


def _tax_year_from(path: Path, page_text: str) -> str | None:
    """Tax year from filename prefix or form text. Returns ISO YYYY-12-31."""
    m = re.match(r"(\d{4})_", path.name)
    if m:
        return f"{m.group(1)}-12-31"
    # Fallback: form has "For calendar year YYYY" near top.
    m = re.search(r"calendar year\s+(\d{4})", page_text)
    if m:
        return f"{m.group(1)}-12-31"
    # Combined K-1 filenames like Masterworks_Combined_K1_2025_36506.pdf.
    m = re.search(r"_(\d{4})_", path.name)
    if m:
        return f"{m.group(1)}-12-31"
    return None


def parse(
    pdf_path: Path, conn: sqlite3.Connection
) -> tuple[float, str | None]:
    """Parse one K-1 PDF, return (sum_of_ending_capital, year_iso)."""
    try:
        import pdfplumber
    except ImportError as e:
        raise RuntimeError(
            "pdfplumber required for K-1 parsing. "
            "Run: .venv/bin/pip install pdfplumber"
        ) from e

    total = 0.0
    year_iso: str | None = None
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            if year_iso is None:
                year_iso = _tax_year_from(pdf_path, text)
            if "Schedule K-1" not in text:
                continue
            ending = _ending_capital_for_page(page)
            if ending is not None:
                total += ending
    return total, year_iso


def ingest_directory(
    folder: Path, conn: sqlite3.Connection
) -> K1Stats:
    stats = K1Stats()
    pdfs = sorted(p for p in folder.iterdir() if p.suffix.lower() == ".pdf")
    if not pdfs:
        print(f"  no PDFs in {folder}")
        return stats

    for path in pdfs:
        total, year_iso = parse(path, conn)
        stats.files_parsed += 1
        if year_iso is None:
            stats.skipped.append(f"{path.name}: no tax year detected")
            continue
        if total <= 0:
            stats.skipped.append(
                f"{path.name}: no Box L ending values found"
            )
            continue

        # Multiple files for the same year sum (one PDF per LLC is
        # common for early-year filings; a Combined K-1 PDF in later
        # years already aggregates internally). Don't mix individual +
        # combined for one year — that would double-count.
        stats.yearly_totals[year_iso] = (
            stats.yearly_totals.get(year_iso, 0.0) + total
        )

        # Audit trail.
        ledger.record_event(
            conn,
            source="masterworks-k1",
            external_id=f"k1|{path.name}",
            payload={
                "file": path.name,
                "year": year_iso,
                "ending_capital_total": total,
            },
            source_file=path.name,
        )
        print(
            f"  {path.name}: tax year {year_iso[:4]}, "
            f"ending capital = ${total:,.2f}"
        )

    # Write one assertion per tax year (pick the largest total — handles
    # combined-vs-individual K-1 overlap).
    for year_iso, total in sorted(stats.yearly_totals.items()):
        ledger.assert_balance(
            conn,
            account_id=MASTERWORKS_ACCOUNT_ID,
            as_of=year_iso,
            expected_usd=total,
            source="masterworks-k1",
            source_file=None,
        )
        stats.assertions_written += 1

    conn.commit()
    return stats


def print_stats(stats: K1Stats) -> None:
    print(f"  files parsed:        {stats.files_parsed}")
    print(f"  assertions written:  {stats.assertions_written}")
    if stats.yearly_totals:
        print(f"  per-year ending capital totals:")
        for year_iso, total in sorted(stats.yearly_totals.items()):
            print(f"    {year_iso}  ${total:,.2f}")
    if stats.skipped:
        print(f"  skipped:")
        for s in stats.skipped:
            print(f"    {s}")
