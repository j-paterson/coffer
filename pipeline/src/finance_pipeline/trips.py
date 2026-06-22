"""Auto-detect trips by clustering Travel-categorized transactions.

A trip is a contiguous run of transactions categorized as Travel where each
consecutive pair is no more than `gap_days` apart. Each trip gets:

- a stable id (hash of sorted txn ids in the cluster)
- a slug + human name auto-generated from the most distinctive city/airport
  string found in any transaction's description
- a date window (first txn date to last txn date)
- a total (sum of transaction amounts in the cluster)

The detector is fully re-runnable: it deletes existing trip rows, recomputes,
re-tags transactions. Doesn't touch non-trip data.

Design notes:
- v1 only counts category=Travel transactions in the trip total. Pulling in
  *all* spending in the date window produces too many false positives (mail-
  order, bills, post-trip dining at home).
- Future work: an "other spending in this window" section in the trip detail
  view, opt-in.
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date

from . import db


# Words that aren't useful for trip naming. We strip these from descriptions
# when looking for a city/place name.
NOISE_PATTERNS = [
    re.compile(r"^TST\*", re.IGNORECASE),
    re.compile(r"^SP\s", re.IGNORECASE),
    re.compile(r"^SQ\s\*?", re.IGNORECASE),
    re.compile(r"^FSP\*", re.IGNORECASE),
    re.compile(r"^DD\s\*?DOORDASH\s*", re.IGNORECASE),
    re.compile(r"^I3P\*", re.IGNORECASE),
    re.compile(r"\b(LLC|INC|CORP|LTD|CO)\b\.?", re.IGNORECASE),
    re.compile(r"\b\d{4,}\b"),  # account/order numbers
]


@dataclass
class Trip:
    id: str
    slug: str
    name: str
    start_date: str
    end_date: str
    total_usd: float
    txn_ids: list[str] = field(default_factory=list)


def _strip_noise(s: str) -> str:
    out = s
    for pat in NOISE_PATTERNS:
        out = pat.sub(" ", out)
    return re.sub(r"\s+", " ", out).strip()


# Hand-curated set of city/region tokens we recognize for trip naming.
# This list grows organically as the user travels.
KNOWN_PLACE_TOKENS = {
    # major US/CA travel destinations
    "BANFF", "WHISTLER", "VAIL", "ASPEN", "TAHOE", "JACKSON",
    "VEGAS", "DENVER", "SEATTLE", "PORTLAND", "HONOLULU",
    "MIAMI", "ORLANDO", "NYC", "BOSTON", "CHICAGO", "AUSTIN",
    "MAUI", "KAUAI", "OAHU",
    # international airports (3-letter codes embedded in descriptions)
    "LHR", "CDG", "NRT", "YYZ", "YYC", "LAX", "JFK", "SFO",
    # countries / regions
    "PARIS", "TOKYO", "LONDON", "ROME", "BARCELONA", "AMSTERDAM",
    "BERLIN", "DUBLIN", "REYKJAVIK",
}


def _detect_place(descs: list[str]) -> str | None:
    """Return a place name found in any of the descriptions, or None.

    Strategy: token-match against KNOWN_PLACE_TOKENS first (curated list),
    then fall back to looking for an all-caps word ≥4 chars that isn't
    obviously noise.
    """
    seen: list[str] = []
    for desc in descs:
        cleaned = _strip_noise(desc).upper()
        for tok in re.findall(r"[A-Z]{3,}", cleaned):
            if tok in KNOWN_PLACE_TOKENS:
                return tok.title()
            if len(tok) >= 4 and tok not in {
                "FROM", "BAGGAGE", "HOTEL", "RENTAL", "RENTALS", "SPORTS",
                "SPRINGS", "RESORT", "AIRPORT", "FLIGHT", "TICKET", "AIRLINE",
                "AIRLINES", "AIR", "PAYMENT", "PURCHASE", "CHARGE", "FEE",
            }:
                seen.append(tok.title())
    return seen[0] if seen else None


def _make_trip_name(start: str, place: str | None) -> tuple[str, str]:
    """Return (slug, human_name) for a trip starting on `start`."""
    d = date.fromisoformat(start)
    month_short = d.strftime("%b")  # 'Feb'
    year = d.strftime("%Y")
    if place:
        name = f"{place} {month_short} {year}"
        slug = f"{place.lower()}-{month_short.lower()}-{year}"
    else:
        name = f"Trip {month_short} {year}"
        slug = f"trip-{month_short.lower()}-{year}"
    # Slug uniqueness handled by caller if multiple trips collide
    return slug, name


def _trip_id(txn_ids: list) -> str:
    txn_ids = [str(t) for t in txn_ids]
    h = hashlib.sha1(",".join(sorted(txn_ids)).encode()).hexdigest()[:8]
    return f"trip-{h}"


def find_trips(
    conn: sqlite3.Connection,
    gap_days: int = 4,
) -> list[Trip]:
    """Cluster Travel-categorized txns into trips. v2: groups one row
    per transactions_v2 entry whose category is 'Travel', summing its
    real-account postings (so a single trip dinner with split tip
    counts once)."""
    rows = conn.execute(
        """
        SELECT t.id          AS id,
               t.date        AS date,
               SUM(p.amount) AS amount,
               t.description AS description,
               MIN(p.payee)  AS payee,
               NULL          AS location_hint
        FROM transactions_v2 t
        JOIN postings p ON p.txn_id = t.id
        WHERE EXISTS (
                SELECT 1 FROM transaction_items i
                WHERE i.transaction_v2_id = t.id
                  AND LOWER(i.category) = 'travel'
              )
          AND p.account_id NOT LIKE 'equity:%'
        GROUP BY t.id
        ORDER BY t.date, t.id
        """
    ).fetchall()

    if not rows:
        return []

    # Walk rows in date order, breaking clusters where the gap exceeds
    # gap_days between consecutive entries.
    clusters: list[list[sqlite3.Row]] = [[rows[0]]]
    for row in rows[1:]:
        prev = clusters[-1][-1]
        gap = (date.fromisoformat(row["date"]) - date.fromisoformat(prev["date"])).days
        if gap <= gap_days:
            clusters[-1].append(row)
        else:
            clusters.append([row])

    trips: list[Trip] = []
    for cluster in clusters:
        txn_ids = [r["id"] for r in cluster]
        # Prefer location_hint (cleanest source); fall back to payee strings;
        # fall back to raw description token scanning.
        place: str | None = None
        for r in cluster:
            if r["location_hint"]:
                # location_hint is already in human form ("Banff" or "City, ST")
                place = r["location_hint"].split(",")[0].strip()
                break
        if not place:
            payee_strings = [r["payee"] or "" for r in cluster]
            place = _detect_place(payee_strings)
        if not place:
            descs = [r["description"] for r in cluster]
            place = _detect_place(descs)
        start = cluster[0]["date"]
        end = cluster[-1]["date"]
        slug, name = _make_trip_name(start, place)
        total = sum(float(r["amount"]) for r in cluster)
        trips.append(
            Trip(
                id=_trip_id(txn_ids),
                slug=slug,
                name=name,
                start_date=start,
                end_date=end,
                total_usd=total,
                txn_ids=txn_ids,
            )
        )
    return trips


def apply_trips(conn: sqlite3.Connection, trips: list[Trip]) -> None:
    """Replace existing auto-detected trip bundles and re-tag transactions_v2.
    Only touches bundles with type='trip' — manually created bundles
    (renovations, projects, etc.) are left untouched."""
    # Only clear trip_ids that belong to auto-detected trip bundles
    conn.execute(
        "UPDATE transactions_v2 SET trip_id = NULL "
        "WHERE trip_id IN (SELECT id FROM bundles WHERE type = 'trip')"
    )
    conn.execute("DELETE FROM bundles WHERE type = 'trip'")
    for trip in trips:
        conn.execute(
            """
            INSERT INTO bundles (id, slug, name, type, start_date, end_date, total_usd, txn_count)
            VALUES (?, ?, ?, 'trip', ?, ?, ?, ?)
            """,
            (
                trip.id,
                trip.slug,
                trip.name,
                trip.start_date,
                trip.end_date,
                trip.total_usd,
                len(trip.txn_ids),
            ),
        )
        placeholders = ",".join("?" for _ in trip.txn_ids)
        conn.execute(
            f"UPDATE transactions_v2 SET trip_id = ? WHERE id IN ({placeholders})",
            (trip.id, *trip.txn_ids),
        )


def detect_trips(gap_days: int = 4, dry_run: bool = False) -> list[Trip]:
    """Top-level: find trips and (optionally) write them to the DB."""
    with db.connect() as conn:
        trips = find_trips(conn, gap_days=gap_days)
        if not dry_run:
            apply_trips(conn, trips)
    return trips


def print_report(trips: list[Trip]) -> None:
    if not trips:
        print("no trips detected")
        return
    print(f"detected {len(trips)} trip(s):")
    for trip in trips:
        print(
            f"  {trip.name:<30}  {trip.start_date} → {trip.end_date}  "
            f"{trip.total_usd:>10.2f}  ({len(trip.txn_ids)} txns)"
        )
