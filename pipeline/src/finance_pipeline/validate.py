"""Balance assertion validator.

For every row in ``balance_assertions``, compute the cumulative sum of
postings on that account up through the asserted date. Any delta
outside TOLERANCE is a reconciliation error — logged to
``reconciliation_notes`` and returned to the caller for surfacing in
the sync-status banner.

The expectation is *not* that every assertion passes. It's that each
delta becomes a visible, named line item instead of being silently
absorbed by a clamp-to-zero hack.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import TypedDict


class DeltaEntry(TypedDict):
    account_id: str
    as_of: str
    expected_usd: float
    actual_usd: float
    delta_usd: float
    source: str

from . import db, ledger


@dataclass
class ValidationReport:
    assertions_checked: int = 0
    passed: int = 0
    failed: int = 0
    worst_deltas: list[DeltaEntry] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "assertions_checked": self.assertions_checked,
            "passed": self.passed,
            "failed": self.failed,
            "worst_deltas": self.worst_deltas,
        }


# Some legacy-imported assertions reflect the OLD walker's flawed
# reconstruction (e.g. 'legacy:backfill:txn'). Those inherit their
# delta from the old system; they're not actionable signal. Skip them
# in the validator so we focus on sources we actually trust.
_TRUSTED_SOURCES = (
    "manual",
    "simplefin",
    "zerion-chart",
    "zerion",
    "alchemy",
    "backfill:yfinance",
)


def validate(
    conn: sqlite3.Connection, tolerance_usd: float = 5.0
) -> ValidationReport:
    rpt = ValidationReport()

    # Merge-aware: roll postings + assertions to canonical so multi-source
    # accounts validate against the combined cumulative sum.
    canonical_by_id: dict[str, str] = {}
    for r in conn.execute("SELECT id, COALESCE(merged_into, id) FROM accounts"):
        canonical_by_id[r[0]] = r[1]

    def canon(acct: str) -> str:
        return canonical_by_id.get(acct, acct)

    by_canon_date: dict[tuple[str, str], float] = {}
    for acct, date, delta in conn.execute(
        """
        SELECT p.account_id, t.date, SUM(p.amount)
        FROM postings p JOIN transactions_v2 t ON t.id = p.txn_id
        GROUP BY p.account_id, t.date
        ORDER BY t.date
        """
    ).fetchall():
        key = (canon(acct), date)
        by_canon_date[key] = by_canon_date.get(key, 0.0) + delta
    cum_by_acct: dict[str, list[tuple[str, float]]] = {}
    for (canonical, date), delta in sorted(by_canon_date.items()):
        lst = cum_by_acct.setdefault(canonical, [])
        running = (lst[-1][1] if lst else 0.0) + delta
        lst.append((date, running))

    def cumulative_on(account_id: str, date: str) -> float:
        """Binary-search the running total up through `date`."""
        lst = cum_by_acct.get(account_id)
        if not lst:
            return 0.0
        # linear is fine — per-account series is small
        total = 0.0
        for d, v in lst:
            if d <= date:
                total = v
            else:
                break
        return total

    # Sum aliases-of-one-canonical within the same source so the assertion
    # we validate matches the bundle total (matches pad's same fix).
    raw_assertions = conn.execute(
        """
        SELECT account_id, as_of, expected_usd, source
        FROM balance_assertions
        WHERE source IN ({})
        """.format(",".join("?" * len(_TRUSTED_SOURCES))),
        _TRUSTED_SOURCES,
    ).fetchall()
    summed_assertions: dict[tuple[str, str, str], float] = {}
    for (acct, as_of, expected, source) in raw_assertions:
        key = (canon(acct), as_of, source)
        summed_assertions[key] = summed_assertions.get(key, 0.0) + expected

    deltas: list[tuple[float, DeltaEntry]] = []
    for (acct, as_of, source), expected in summed_assertions.items():
        rpt.assertions_checked += 1
        actual = cumulative_on(acct, as_of)
        delta = actual - expected
        if abs(delta) <= tolerance_usd:
            rpt.passed += 1
            continue
        rpt.failed += 1
        entry = {
            "account_id": acct,
            "as_of": as_of,
            "expected_usd": expected,
            "actual_usd": round(actual, 2),
            "delta_usd": round(delta, 2),
            "source": source,
        }
        ledger.note_reconciliation(
            conn, acct, as_of, "assertion_delta", entry
        )
        deltas.append((abs(delta), entry))

    # Surface the 20 biggest deltas for the user.
    deltas.sort(key=lambda x: -x[0])
    rpt.worst_deltas = [e for _, e in deltas[:20]]
    conn.commit()
    return rpt


def run(tolerance_usd: float = 5.0) -> ValidationReport:
    with db.connect() as conn:
        return validate(conn, tolerance_usd=tolerance_usd)


def print_report(rpt: ValidationReport) -> None:
    print(f"  assertions checked:  {rpt.assertions_checked}")
    print(f"  passed:              {rpt.passed}")
    print(f"  failed:              {rpt.failed}")
    if rpt.worst_deltas:
        print(f"  top deltas:")
        for e in rpt.worst_deltas[:10]:
            print(
                f"    {e['as_of']}  delta={e['delta_usd']:>12,.2f}  "
                f"expected={e['expected_usd']:>12,.2f}  {e['source']:<20}  "
                f"{e['account_id'][:50]}"
            )
