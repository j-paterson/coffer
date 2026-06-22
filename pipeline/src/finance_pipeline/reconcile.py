"""Account reconciliation between sources.

When the same real-world account exists in both manual entries (e.g. a
user-curated snapshot) and a live API sync, we want to treat the live
version as canonical and archive the manual one so it stops contributing
to net worth totals.

Matching strategy (v1): strict. A manual account is archived when it shares
BOTH a last-4-digit suffix AND a normalized institution prefix with an
active live account. We prefer false negatives over false positives —
unmatched accounts remain active and the user can archive them manually.
"""
from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass


# 3-5 digit account suffix. 4 digits is typical ("...8166") but some banks
# only mask to 3 digits ("Schwab ...595") and some show longer fragments.
SUFFIX_RE = re.compile(r"(?<![0-9])(\d{3,5})(?![0-9])")

# Words we ignore when doing fuzzy name matching — they appear in too many
# account names to be distinguishing signal.
NOISE_WORDS = {
    "bank",
    "card",
    "account",
    "credit",
    "checking",
    "savings",
    "shared",
    "rewards",
    "signature",
    "primary",
    "personal",
    "the",
    "and",
}


@dataclass
class ReconcileMatch:
    manual_id: str
    manual_name: str
    manual_type: str
    live_id: str
    live_name: str
    live_type: str
    matched_on: str  # e.g. "suffix=8166, inst=northwind"


def _extract_suffix(name: str) -> str | None:
    """Pull the 4-digit account suffix from a display name, if present."""
    if not name:
        return None
    m = SUFFIX_RE.search(name)
    return m.group(1) if m else None


def _normalize_institution(inst: str) -> str:
    """Lowercase first significant word of an institution string."""
    if not inst:
        return ""
    # Strip punctuation, take first word
    words = re.findall(r"[A-Za-z]+", inst.lower())
    return words[0] if words else ""


def _extract_keywords(name: str) -> set[str]:
    """Return the distinctive lowercase words from an account name.

    Drops words < 4 chars, pure-digit tokens, and NOISE_WORDS.
    """
    if not name:
        return set()
    words = re.findall(r"[A-Za-z]+", name.lower())
    return {w for w in words if len(w) >= 4 and w not in NOISE_WORDS}


# Account type macro-groups. Used to decide whether to trust the user's
# manual type or the live feed's auto-classified type when they disagree
# during reconcile.
_BANKING = frozenset({"checking", "savings"})
_INVESTMENTS = frozenset({"brokerage", "retirement"})
_DEBT = frozenset({"credit"})
_ALT = frozenset({"crypto", "alt", "manual"})


def _type_group(t: str) -> frozenset[str]:
    for g in (_BANKING, _INVESTMENTS, _DEBT, _ALT):
        if t in g:
            return g
    return frozenset()


def _choose_type(manual_type: str, live_type: str) -> str:
    """Pick the final type for a merged account.

    When the user's manual classification and the live feed disagree:
      - Different macro-groups (e.g. checking vs brokerage): trust the
        manual type. The live feed's keyword heuristic gets the high-level
        bucket wrong more often than the user does.
      - Same macro-group, retirement involved: pick retirement. IRAs
        are retirement regardless of which side flagged it.
      - Otherwise same macro-group: trust the live type.
    """
    if manual_type == live_type:
        return live_type
    if _type_group(manual_type) != _type_group(live_type):
        return manual_type
    if "retirement" in (manual_type, live_type):
        return "retirement"
    return live_type


def _suffix_matches(a: str | None, b: str | None) -> bool:
    """One suffix ends with the other (end-aligned), min 3 chars on both.

    Catches the common case where a manual entry shows "...9942" and the
    live feed shows "...942" for the same real-world account.
    """
    if not a or not b or len(a) < 3 or len(b) < 3:
        return False
    return a.endswith(b) or b.endswith(a)


def find_matches(conn: sqlite3.Connection) -> list[ReconcileMatch]:
    """Find manual accounts that are superseded by a live-mode account.

    Matching runs across account types deliberately: the live feed's
    type classification is a heuristic keyword match on the account
    name, so e.g. a Schwab "Investor Checking" can end up typed as
    brokerage. The manual entry might have the correct type, and the
    goal of reconcile is to merge them regardless of the section mismatch.
    """
    conn.row_factory = sqlite3.Row
    live_rows = conn.execute(
        """
        SELECT id, display_name, institution, type
        FROM accounts
        WHERE mode = 'live' AND active = 1
        """
    ).fetchall()

    manual_rows = conn.execute(
        """
        SELECT id, display_name, institution, type
        FROM accounts
        WHERE mode = 'manual' AND active = 1
        """
    ).fetchall()

    matches: list[ReconcileMatch] = []
    matched_manual_ids: set[str] = set()

    # Pass 1: institution prefix + suffix containment.
    # Pairwise compare so we can use suffix containment instead of exact
    # equality — catches 9942/942 and similar length-mismatched suffixes.
    for sf in live_rows:
        sf_suffix = _extract_suffix(sf["display_name"])
        sf_inst = _normalize_institution(sf["institution"])
        if not sf_suffix or not sf_inst:
            continue
        for k in manual_rows:
            if k["id"] in matched_manual_ids:
                continue
            if _normalize_institution(k["institution"]) != sf_inst:
                continue
            if _suffix_matches(sf_suffix, _extract_suffix(k["display_name"])):
                matches.append(
                    ReconcileMatch(
                        manual_id=k["id"],
                        manual_name=k["display_name"],
                        manual_type=k["type"],
                        live_id=sf["id"],
                        live_name=sf["display_name"],
                        live_type=sf["type"],
                        matched_on=f"suffix={sf_suffix}, inst={sf_inst}",
                    )
                )
                matched_manual_ids.add(k["id"])
                break

    # Pass 2: fuzzy keyword overlap, institution-scoped.
    # Same institution prefix AND ≥1 distinctive keyword overlap in the
    # display name. The institution token itself is filtered out of the
    # overlap count — otherwise "Northwind BUS COMPLETE CHK" would match
    # "Northwind Signature" via the shared word "northwind".
    for sf in live_rows:
        sf_inst = _normalize_institution(sf["institution"])
        if not sf_inst:
            continue
        sf_keywords = _extract_keywords(sf["display_name"]) - {sf_inst}
        if not sf_keywords:
            continue
        for k in manual_rows:
            if k["id"] in matched_manual_ids:
                continue
            if _normalize_institution(k["institution"]) != sf_inst:
                continue
            k_keywords = _extract_keywords(k["display_name"]) - {sf_inst}
            overlap = sf_keywords & k_keywords
            if len(overlap) >= 1:
                matches.append(
                    ReconcileMatch(
                        manual_id=k["id"],
                        manual_name=k["display_name"],
                        manual_type=k["type"],
                        live_id=sf["id"],
                        live_name=sf["display_name"],
                        live_type=sf["type"],
                        matched_on=f"keywords={sorted(overlap)}",
                    )
                )
                matched_manual_ids.add(k["id"])
                break

    # Pass 3: match-by-elimination, guarded.
    # Only fires when ALL of:
    #   - exactly one unmatched live + one unmatched manual at the institution
    #   - they belong to the same type macro-group (banking/investments/etc.),
    #     so we don't pair e.g. a Vanguard Roth (retirement) with a Vanguard
    #     Brokerage entry the user just hasn't synced yet
    # The sole-pair pass is otherwise dangerous: the user might have a real
    # account at an institution that simply isn't in the live feed yet, and
    # blindly pairing would silently archive a real manual entry.
    matched_live_ids: set[str] = {m.live_id for m in matches}
    by_inst_live: dict[str, list[sqlite3.Row]] = {}
    by_inst_manual: dict[str, list[sqlite3.Row]] = {}
    for sf in live_rows:
        if sf["id"] in matched_live_ids:
            continue
        inst = _normalize_institution(sf["institution"])
        if inst:
            by_inst_live.setdefault(inst, []).append(sf)
    for k in manual_rows:
        if k["id"] in matched_manual_ids:
            continue
        inst = _normalize_institution(k["institution"])
        if inst:
            by_inst_manual.setdefault(inst, []).append(k)
    for inst, lives in by_inst_live.items():
        manuals = by_inst_manual.get(inst, [])
        if len(lives) != 1 or len(manuals) != 1:
            continue
        sf, k = lives[0], manuals[0]
        if _type_group(sf["type"]) != _type_group(k["type"]):
            continue
        matches.append(
            ReconcileMatch(
                manual_id=k["id"],
                manual_name=k["display_name"],
                manual_type=k["type"],
                live_id=sf["id"],
                live_name=sf["display_name"],
                live_type=sf["type"],
                matched_on=f"sole-pair@{inst}",
            )
        )
        matched_manual_ids.add(k["id"])

    return matches


def apply_matches(conn: sqlite3.Connection, matches: list[ReconcileMatch]) -> int:
    """Delete matched manual accounts (and all their child rows).

    Triggered when a live sync covers the same real-world account as a
    manual entry. Also inherits the manual entry's `type` onto the live
    account when they differ — the live feed's type heuristic
    mis-classifies (e.g. Schwab "Investor Checking" as brokerage), so a
    matching user-curated manual type is a trusted correction.

    Deletes every child row in every table with an FK to accounts, then
    the account itself. Self-referential merged_into pointers are NULLed
    first so the account row can be removed. position_snapshots is not
    listed — positions.account_id FK cascades to snapshots automatically.
    Runs inside the caller's transaction.
    """
    if not matches:
        return 0

    # Reconcile the type on the live account: if the manual and live
    # types disagree, pick via macro-group heuristic. See _choose_type.
    for m in matches:
        if m.manual_type and m.live_type and m.manual_type != m.live_type:
            chosen = _choose_type(m.manual_type, m.live_type)
            if chosen != m.live_type:
                conn.execute(
                    "UPDATE accounts SET type = ? WHERE id = ? AND mode = 'live'",
                    (chosen, m.live_id),
                )

    ids = [m.manual_id for m in matches]
    placeholders = ",".join("?" for _ in ids)

    # Null out self-ref merged_into before deleting — an archived account
    # may still be the canonical target for an earlier merge.
    conn.execute(
        f"UPDATE accounts SET merged_into = NULL WHERE merged_into IN ({placeholders})",
        ids,
    )

    for table in (
        "balance_assertions",
        "postings",
        "positions",
        "reconciliation_notes",
        "debt_terms",
    ):
        conn.execute(
            f"DELETE FROM {table} WHERE account_id IN ({placeholders})",
            ids,
        )

    cur = conn.execute(
        f"DELETE FROM accounts WHERE id IN ({placeholders}) AND mode = 'manual'",
        ids,
    )
    return cur.rowcount


# ---------- transaction-level cross-source dedup -------------------------
#
# The same real-world charge can be observed by multiple sources — e.g. a
# credit-card purchase observed both via the live bank feed and via a
# secondary feed of the same account, with slightly different dates
# (pending vs. posted) and descriptions of varying detail. Without dedup,
# both land as distinct ``transactions_v2`` rows, double-counting in
# spending totals and splitting receipt matches.
#
# The safety invariant that keeps this heuristic honest: we only collapse
# txns whose supporting ``raw_events`` come from *different* source
# providers. A same-source pair (two separate provider TRN ids observed
# on the same day at the same amount to the same payee) is a legitimate
# repeat charge (two $450 Zelles to the same friend, etc.) and must be
# preserved. The stable provider external_id is the ground truth for
# event identity; this pass only bridges across providers.


@dataclass
class DedupStats:
    clusters: int = 0
    merged_losers: int = 0          # count of txns collapsed into canonicals
    event_links_moved: int = 0
    items_repointed: int = 0
    emails_repointed: int = 0
    tags_unioned: int = 0


def _candidate_duplicate_pairs(
    conn: sqlite3.Connection, window_days: int
) -> list[tuple[int, int]]:
    """All ordered (a<b) txn pairs that match on canonical account,
    signed amount, currency, normalized (lowercased) description, and
    dates within ``window_days``. Equity postings are excluded.

    This is the SQL-cheap candidate set; cross-source filtering happens
    in Python against a preloaded per-txn source map.
    """
    rows = conn.execute(
        """
        WITH txn_sig AS (
          SELECT t.id AS txn_id,
                 t.date,
                 LOWER(COALESCE(t.description, '')) AS desc_lower,
                 COALESCE(a.merged_into, p.account_id) AS canon_account,
                 p.amount,
                 p.currency
          FROM transactions_v2 t
          JOIN postings p ON p.txn_id = t.id
          LEFT JOIN accounts a ON a.id = p.account_id
          WHERE p.account_id NOT LIKE 'equity:%'
        )
        SELECT s1.txn_id AS a, s2.txn_id AS b
        FROM txn_sig s1
        JOIN txn_sig s2
          ON s2.canon_account = s1.canon_account
         AND s2.amount = s1.amount
         AND s2.currency = s1.currency
         AND s2.desc_lower = s1.desc_lower
         AND s2.txn_id > s1.txn_id
         AND ABS(julianday(s2.date) - julianday(s1.date)) <= ?
        """,
        (window_days,),
    ).fetchall()
    return [(r["a"], r["b"]) for r in rows]


def _load_source_map(
    conn: sqlite3.Connection,
) -> dict[int, frozenset[str]]:
    """txn_id -> frozenset of source identifiers backing it.

    Uses derived_by as the primary source identity so that transactions
    created by different pipelines (e.g. ingest vs simplefin) are
    recognized as cross-source even when their event_links point to the
    same raw_events provider. Falls back to raw_events.source for txns
    that lack derived_by.
    """
    tmp: dict[int, set[str]] = {}
    for row in conn.execute(
        "SELECT id, derived_by FROM transactions_v2 WHERE derived_by IS NOT NULL"
    ).fetchall():
        tmp.setdefault(row["id"], set()).add(row["derived_by"])
    for row in conn.execute(
        """
        SELECT el.txn_id, re.source
        FROM event_links el
        JOIN raw_events re ON re.id = el.raw_id
        """
    ).fetchall():
        if row["txn_id"] not in tmp:
            tmp.setdefault(row["txn_id"], set()).add(row["source"])
    return {k: frozenset(v) for k, v in tmp.items()}


def find_duplicate_clusters(
    conn: sqlite3.Connection, window_days: int = 3
) -> list[list[int]]:
    """Find clusters of ``transactions_v2`` ids that represent the same
    real-world event observed across different source providers.

    Invariant: every pair (a, b) in every cluster has at least one
    ``raw_events.source`` value present on one side but not the other.
    Same-source pairs (including "both already link to the same set of
    sources") are never grouped — see module-level comment.

    Each cluster is returned sorted ascending; the list itself is sorted
    by the smallest id in each cluster for deterministic iteration.
    """
    pairs = _candidate_duplicate_pairs(conn, window_days)
    sources = _load_source_map(conn)

    # Keep only pairs whose supporting sources genuinely differ — this is
    # the cross-source safety guard.
    cross_pairs: list[tuple[int, int]] = []
    for a, b in pairs:
        sa = sources.get(a, frozenset())
        sb = sources.get(b, frozenset())
        if not sa or not sb:
            # Missing audit trail on either side — can't vouch for
            # provider identity, refuse to merge.
            continue
        if sa == sb:
            continue
        cross_pairs.append((a, b))

    if not cross_pairs:
        return []

    # Union-find over cross-source pairs.
    parent: dict[int, int] = {}

    def _find(x: int) -> int:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(a: int, b: int) -> None:
        ra, rb = _find(a), _find(b)
        if ra != rb:
            parent[ra] = rb

    for a, b in cross_pairs:
        _union(a, b)

    groups: dict[int, list[int]] = {}
    for node in list(parent.keys()):
        groups.setdefault(_find(node), []).append(node)

    # Second safety pass: within a cluster, every source provider must
    # appear at most once. Union-find can transitively rope two
    # same-source rows into the same cluster via a shared cross-source
    # partner (e.g. two live-feed Zelles both tied to one statement row —
    # the Zelles are legitimate separate payments and must survive).
    clusters: list[list[int]] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        seen_sources: set[str] = set()
        collision = False
        for tid in members:
            for s in sources.get(tid, frozenset()):
                if s in seen_sources:
                    collision = True
                    break
                seen_sources.add(s)
            if collision:
                break
        if collision:
            continue
        clusters.append(sorted(members))

    clusters.sort(key=lambda c: c[0])
    return clusters


def _merge_cluster(
    conn: sqlite3.Connection,
    canonical: int,
    losers: list[int],
    stats: DedupStats,
) -> None:
    """Fold every loser's audit + metadata into canonical, then delete
    the loser txn rows. ``postings`` cascade-drop with the txn."""
    # event_links: move losers' raw_event linkage to canonical. PK is
    # (txn_id, raw_id); INSERT OR IGNORE then DELETE handles the edge
    # case where a raw_id is somehow linked to both already.
    for loser in losers:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO event_links (txn_id, raw_id)
            SELECT ?, raw_id FROM event_links WHERE txn_id = ?
            """,
            (canonical, loser),
        )
        stats.event_links_moved += cur.rowcount or 0
        conn.execute("DELETE FROM event_links WHERE txn_id = ?", (loser,))

        cur = conn.execute(
            "UPDATE transaction_items SET transaction_v2_id = ? WHERE transaction_v2_id = ?",
            (canonical, loser),
        )
        stats.items_repointed += cur.rowcount or 0

        cur = conn.execute(
            "UPDATE emails SET transaction_v2_id = ? WHERE transaction_v2_id = ?",
            (canonical, loser),
        )
        stats.emails_repointed += cur.rowcount or 0

    # Inherit metadata onto canonical for any field canonical is missing.
    # Tags: union. trip_id/notes: first-non-null-wins, canonical preferred.
    # Description stays as-is (matched on normalization). Category lives on
    # transaction_items now (migration 044) and follows automatically when
    # items get repointed above.
    can = conn.execute(
        "SELECT tags, trip_id, notes FROM transactions_v2 WHERE id = ?",
        (canonical,),
    ).fetchone()
    if can is None:
        return

    trip_id = can["trip_id"]
    notes = can["notes"]
    tags: set[str] = set()
    if can["tags"]:
        tags.update(t.strip() for t in can["tags"].split(",") if t.strip())

    for loser in losers:
        l = conn.execute(
            "SELECT tags, trip_id, notes FROM transactions_v2 WHERE id = ?",
            (loser,),
        ).fetchone()
        if l is None:
            continue
        if not trip_id and l["trip_id"]:
            trip_id = l["trip_id"]
        if not notes and l["notes"]:
            notes = l["notes"]
        if l["tags"]:
            before = len(tags)
            tags.update(t.strip() for t in l["tags"].split(",") if t.strip())
            stats.tags_unioned += max(0, len(tags) - before)

    tags_csv = ",".join(sorted(tags)) if tags else None
    conn.execute(
        """
        UPDATE transactions_v2
        SET tags = ?, trip_id = ?, notes = ?
        WHERE id = ?
        """,
        (tags_csv, trip_id, notes, canonical),
    )

    # Audit trail: record which txns collapsed into which, on the
    # canonical's account + date, so merges are reversible by inspection.
    canon_acct_row = conn.execute(
        "SELECT account_id FROM postings "
        "WHERE txn_id = ? AND account_id NOT LIKE 'equity:%' LIMIT 1",
        (canonical,),
    ).fetchone()
    canon_date_row = conn.execute(
        "SELECT date FROM transactions_v2 WHERE id = ?", (canonical,)
    ).fetchone()
    if canon_acct_row and canon_date_row:
        conn.execute(
            """
            INSERT INTO reconciliation_notes (account_id, as_of, kind, detail)
            VALUES (?, ?, 'dedup', ?)
            """,
            (
                canon_acct_row["account_id"],
                canon_date_row["date"],
                json.dumps(
                    {
                        "canonical_txn_v2_id": canonical,
                        "merged_txn_v2_ids": losers,
                    }
                ),
            ),
        )

    placeholders = ",".join("?" for _ in losers)
    conn.execute(
        f"DELETE FROM transactions_v2 WHERE id IN ({placeholders})",
        losers,
    )
    stats.merged_losers += len(losers)


def dedup_transactions(
    conn: sqlite3.Connection,
    window_days: int = 3,
    dry_run: bool = False,
) -> DedupStats:
    """Collapse cross-source duplicate v2 transactions.

    Safe-by-construction: only merges pairs whose raw_events come from
    different source providers (see ``find_duplicate_clusters``). Pick
    the smallest-id member of each cluster as canonical, move every
    audit and receipt FK onto it, write a ``reconciliation_notes`` row
    with the merged ids, then drop the losers (postings cascade).
    """
    stats = DedupStats()
    clusters = find_duplicate_clusters(conn, window_days=window_days)
    stats.clusters = len(clusters)
    if not clusters or dry_run:
        return stats

    for members in clusters:
        canonical, *losers = members
        _merge_cluster(conn, canonical, losers, stats)
    return stats


def print_dedup_report(stats: DedupStats) -> None:
    print(f"clusters:           {stats.clusters}")
    print(f"merged losers:      {stats.merged_losers}")
    print(f"event_links moved:  {stats.event_links_moved}")
    print(f"items repointed:    {stats.items_repointed}")
    print(f"emails repointed:   {stats.emails_repointed}")
