"""Rules-based transaction categorization.

Loads a YAML rules file and applies categories + tags to rows in
``transactions_v2`` (reading account_id + amount from ``postings``).
Also runs an upstream pre-pass that detects internal-account transfer
pairs (e.g., a credit card autopay shows up as both a positive leg on
the card account and a negative leg on checking — neither is real
spending).

Design notes:
- Rules are pure data; this module is the only place they're interpreted.
- Pre-pass for transfer pairs runs first and writes category='Transfer'
  so rule evaluation skips them.
- Tags are stored as a comma-separated string on transactions_v2.tags.
  Existing tags are preserved and unioned with new ones.
- Subcategory detail belongs on ``transaction_items`` (LLM receipt
  extraction), not on the txn — it's intentionally not written here.
"""
from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import db
from .config import RULES_PATH


@dataclass
class Condition:
    field: str       # 'description' | 'amount' | 'account_id'
    op: str          # see CONDITION_OPS
    value: str | float | None = None
    values: list[str] | None = None


@dataclass
class Action:
    kind: str        # 'set' | 'add_tag' | 'stop'
    target: str | None = None   # for 'set': category|subcategory
    value: str | float | None = None


@dataclass
class Rule:
    name: str
    priority: int
    conditions: list[Condition]
    actions: list[Action]


@dataclass
class RuleSet:
    categories: list[str]
    rules: list[Rule]


@dataclass
class CategorizeStats:
    processed: int = 0
    matched: int = 0
    transfer_pairs: int = 0
    transfer_txns: int = 0
    rule_hits: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    unmatched_sample: list[tuple[float, str]] = field(default_factory=list)
    learned_applied: int = 0


def load_rules(path: Path = RULES_PATH) -> RuleSet:
    if not path.exists():
        raise FileNotFoundError(
            f"rules file not found at {path}. Copy rules.example.yaml first."
        )
    raw = yaml.safe_load(path.read_text()) or {}
    categories = list(raw.get("categories", []))
    rules: list[Rule] = []
    for r in raw.get("rules", []):
        conditions = [_parse_condition(c) for c in r.get("when", [])]
        actions = [_parse_action(a) for a in r.get("then", [])]
        rules.append(
            Rule(
                name=r["name"],
                priority=int(r.get("priority", 100)),
                conditions=conditions,
                actions=actions,
            )
        )
    rules.sort(key=lambda x: x.priority)

    # Sanity check: every category referenced by a rule should be declared.
    declared = set(categories)
    for rule in rules:
        for action in rule.actions:
            if action.kind == "set" and action.target == "category":
                if action.value not in declared:
                    print(
                        f"  warning: rule '{rule.name}' references undeclared "
                        f"category '{action.value}'"
                    )

    return RuleSet(categories=categories, rules=rules)


def _parse_condition(raw: dict) -> Condition:
    return Condition(
        field=raw["field"],
        op=raw["op"],
        value=raw.get("value"),
        values=raw.get("values"),
    )


def _parse_action(raw: dict) -> Action:
    if "stop" in raw:
        return Action(kind="stop")
    if "add_tag" in raw:
        return Action(kind="add_tag", value=raw["add_tag"])
    if "set" in raw:
        return Action(kind="set", target=raw["set"], value=raw["value"])
    raise ValueError(f"unknown action shape: {raw}")


def _eval_condition(cond: Condition, txn: sqlite3.Row) -> bool:
    raw = txn[cond.field]
    if cond.field == "amount":
        n = float(raw)
        v = float(cond.value) if cond.value is not None else 0.0
        if cond.op == "gt":
            return n > v
        if cond.op == "gte":
            return n >= v
        if cond.op == "lt":
            return n < v
        if cond.op == "lte":
            return n <= v
        raise ValueError(f"bad amount op: {cond.op}")

    s = "" if raw is None else str(raw)
    if cond.op == "equals":
        return s == cond.value
    if cond.op == "contains":
        return cond.value in s
    if cond.op == "contains_any":
        return any(v in s for v in (cond.values or []))
    if cond.op == "starts_with":
        return s.startswith(cond.value)
    if cond.op == "regex":
        return re.search(cond.value, s) is not None
    raise ValueError(f"bad string op: {cond.op}")


def _apply_actions(
    actions: list[Action],
    state: dict,
) -> bool:
    """Mutate state with action effects. Returns True if `stop` encountered."""
    for action in actions:
        if action.kind == "stop":
            return True
        if action.kind == "set":
            state[action.target] = action.value
        elif action.kind == "add_tag":
            state["tags"].add(action.value)
    return False


def find_transfer_pairs(
    conn: sqlite3.Connection,
    window_days: int = 5,
) -> list[tuple[int, int, float]]:
    """Find pairs of internal-account transactions that mirror each other.

    Heuristic: same |amount|, opposite signs, different accounts (both
    user accounts — equity:* is excluded), within `window_days` of each
    other. Pure read — does not mutate the DB.

    Returns a list of (txn_v2_id_a, txn_v2_id_b, amount) tuples.
    """
    # Categories live on transaction_items post-migration 044. Treat a txn
    # as a transfer-pair candidate when no item carries a non-transfer
    # category (NULL items still qualify — they're the synthesized rows
    # for unitemized bank txns, which is exactly what we want to pair).
    rows = conn.execute(
        """
        SELECT t.id, p.account_id, t.date, p.amount, t.description, t.tags
        FROM transactions_v2 t
        JOIN postings p ON p.txn_id = t.id
        WHERE NOT EXISTS (
                SELECT 1 FROM transaction_items i
                WHERE i.transaction_v2_id = t.id
                  AND i.category IS NOT NULL
                  AND LOWER(i.category) NOT IN ('transfer', 'transfers')
              )
          AND p.account_id NOT LIKE 'equity:%'
        ORDER BY ABS(p.amount) DESC, t.date
        """
    ).fetchall()

    # Group by absolute amount
    by_amount: dict[float, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        if r["amount"] == 0:
            continue
        by_amount[abs(r["amount"])].append(r)

    pairs: list[tuple[int, int, float]] = []
    paired_ids: set[int] = set()

    for amt, group in by_amount.items():
        if len(group) < 2:
            continue
        positives = [r for r in group if r["amount"] > 0]
        negatives = [r for r in group if r["amount"] < 0]
        # Greedy: for each positive, find the closest unpaired negative on a
        # different account within the window.
        for pos in positives:
            if pos["id"] in paired_ids:
                continue
            best: sqlite3.Row | None = None
            best_delta = window_days + 1
            for neg in negatives:
                if neg["id"] in paired_ids:
                    continue
                if neg["account_id"] == pos["account_id"]:
                    continue
                delta = abs(_date_delta_days(pos["date"], neg["date"]))
                if delta <= window_days and delta < best_delta:
                    best = neg
                    best_delta = delta
            if best is not None:
                pairs.append((pos["id"], best["id"], amt))
                paired_ids.add(pos["id"])
                paired_ids.add(best["id"])

    return pairs


def apply_transfer_pairs(
    conn: sqlite3.Connection,
    pairs: list[tuple[int, int, float]],
) -> None:
    """Tag both sides of each pair as Transfer / transfer-pair."""
    for id_a, id_b, _ in pairs:
        for tid in (id_a, id_b):
            existing = conn.execute(
                "SELECT tags FROM transactions_v2 WHERE id = ?", (tid,)
            ).fetchone()
            tags = _merge_tags(existing["tags"] if existing else None, "transfer-pair")
            conn.execute(
                "UPDATE transactions_v2 SET tags = ? WHERE id = ?",
                (tags, tid),
            )
            conn.execute(
                """
                UPDATE transaction_items
                SET category = 'Transfer',
                    category_source = 'transfer-pair'
                WHERE transaction_v2_id = ?
                """,
                (tid,),
            )


def relink_transfer_counterparties(
    conn: sqlite3.Connection,
    pairs: list[tuple[int, int, float]],
) -> int:
    """Merge transfer pairs into properly-linked two-account transactions.

    Before merge:
      txn_a  (account_x, -$5000)  +  (equity:unknown, +$5000)
      txn_b  (account_y, +$5000)  +  (equity:unknown, -$5000)

    After merge:
      txn_a  (account_x, -$5000)  +  (account_y, +$5000)
      txn_b  deleted

    Keeps the lower-ID transaction as canonical (same convention as dedup).
    Only merges when both transactions have exactly one real-account posting
    plus one equity:unknown-counterparty posting — complex multi-leg
    transactions are left untouched.
    """
    import json

    relinked = 0
    for id_a, id_b, amount in pairs:
        canonical = min(id_a, id_b)
        loser = max(id_a, id_b)

        canon_postings = conn.execute(
            "SELECT id, account_id FROM postings WHERE txn_id = ?",
            (canonical,),
        ).fetchall()
        loser_postings = conn.execute(
            "SELECT id, account_id FROM postings WHERE txn_id = ?",
            (loser,),
        ).fetchall()

        if len(canon_postings) != 2 or len(loser_postings) != 2:
            continue

        canon_equity = [p for p in canon_postings if p["account_id"].startswith("equity:")]
        canon_real = [p for p in canon_postings if not p["account_id"].startswith("equity:")]
        loser_real = [p for p in loser_postings if not p["account_id"].startswith("equity:")]

        if len(canon_equity) != 1 or len(canon_real) != 1 or len(loser_real) != 1:
            continue

        conn.execute(
            "UPDATE postings SET account_id = ? WHERE id = ?",
            (loser_real[0]["account_id"], canon_equity[0]["id"]),
        )

        conn.execute(
            "UPDATE OR IGNORE event_links SET txn_id = ? WHERE txn_id = ?",
            (canonical, loser),
        )
        conn.execute("DELETE FROM event_links WHERE txn_id = ?", (loser,))

        canon_date = conn.execute(
            "SELECT date FROM transactions_v2 WHERE id = ?", (canonical,),
        ).fetchone()
        if canon_date:
            conn.execute(
                """INSERT INTO reconciliation_notes
                   (account_id, as_of, kind, detail)
                   VALUES (?, ?, 'transfer_merge', ?)""",
                (
                    canon_real[0]["account_id"],
                    canon_date["date"],
                    json.dumps({
                        "canonical_txn_v2_id": canonical,
                        "merged_txn_v2_id": loser,
                        "counterparty": loser_real[0]["account_id"],
                    }),
                ),
            )

        # Repoint the loser's children before deleting it. postings cascade
        # (ON DELETE CASCADE), but transaction_items and emails do not, so
        # leaving them would violate their FK to transactions_v2. Mirror the
        # dedup merge path.
        conn.execute(
            "UPDATE transaction_items SET transaction_v2_id = ? WHERE transaction_v2_id = ?",
            (canonical, loser),
        )
        conn.execute(
            "UPDATE emails SET transaction_v2_id = ? WHERE transaction_v2_id = ?",
            (canonical, loser),
        )

        conn.execute("DELETE FROM transactions_v2 WHERE id = ?", (loser,))
        relinked += 1

    return relinked


def _date_delta_days(a: str, b: str) -> int:
    """ISO date string difference in days. Cheap, no datetime parsing."""
    from datetime import date

    da = date.fromisoformat(a)
    db_ = date.fromisoformat(b)
    return (da - db_).days


def _merge_tags(existing: str | None, *new_tags: str) -> str:
    parts: set[str] = set()
    if existing:
        parts.update(t.strip() for t in existing.split(",") if t.strip())
    parts.update(new_tags)
    return ",".join(sorted(parts))


def apply_learned_rules(conn: sqlite3.Connection, dry_run: bool = False) -> int:
    """Forward-apply learned keyword->category mappings (user_item_rules).

    The server records a learned rule each time a user sets a category in the
    UI, but historically nothing re-applied it — so a categorized merchant
    reappeared as Uncategorized on the next sync. This applies those mappings
    to items that are still uncategorized.

    Only touches genuinely-uncategorized items: never an already-set category
    (so rules.yaml and receipt/user provenance win) and never a 'user' row (a
    deliberate clear sets category NULL + source 'user'). Higher-hit keywords
    are applied first, so they win keyword conflicts and lower-hit rules cannot
    overwrite them.
    """
    learned = conn.execute(
        "SELECT keyword, category, hits FROM user_item_rules "
        "WHERE keyword IS NOT NULL AND TRIM(keyword) != '' "
        "ORDER BY hits DESC, category ASC"
    ).fetchall()

    guard = (
        "category IS NULL "
        "AND (category_source IS NULL OR category_source != 'user') "
        "AND LOWER(COALESCE(short_name, name)) LIKE ?"
    )
    applied = 0
    for row in learned:
        keyword = (row["keyword"] or "").strip().lower()
        if not keyword:
            continue
        like = f"%{keyword}%"
        if dry_run:
            applied += conn.execute(
                f"SELECT COUNT(*) AS n FROM transaction_items WHERE {guard}",
                (like,),
            ).fetchone()["n"]
            continue
        cur = conn.execute(
            f"UPDATE transaction_items "
            f"SET category = ?, category_source = 'learned' WHERE {guard}",
            (row["category"], like),
        )
        applied += cur.rowcount or 0
    return applied


def categorize(
    rules_path: Path = RULES_PATH,
    dry_run: bool = False,
    only_uncategorized: bool = False,
) -> CategorizeStats:
    """Apply categorization rules to all transactions in the DB."""
    ruleset = load_rules(rules_path)
    print(f"loaded {len(ruleset.rules)} rules from {rules_path.name}")
    with db.connect() as conn:
        return _run_categorize(conn, ruleset, dry_run, only_uncategorized)


def _run_categorize(
    conn: sqlite3.Connection,
    ruleset: RuleSet,
    dry_run: bool,
    only_uncategorized: bool,
) -> CategorizeStats:
    stats = CategorizeStats()

    # Pre-pass: transfer pair detection (read-only first, apply if not dry)
    pairs = find_transfer_pairs(conn)
    stats.transfer_pairs = len(pairs)
    stats.transfer_txns = len(pairs) * 2
    paired_ids = {pid for pair in pairs for pid in (pair[0], pair[1])}
    if not dry_run:
        apply_transfer_pairs(conn, pairs)

    # Fetch txns for rule evaluation. Skip rows that were just paired.
    # JOIN postings for the account_id + amount columns the rules read.
    # Equity postings are excluded so the rule evaluator only sees the
    # user-account side. Transactions with multiple user-account legs
    # (real cross-account transfers) are evaluated once per leg, same
    # as the v1 shape where each leg was a separate row.
    where = ["1=1"]
    if only_uncategorized:
        where.append(
            "NOT EXISTS (SELECT 1 FROM transaction_items i "
            "WHERE i.transaction_v2_id = t.id AND i.category IS NOT NULL)"
        )
    where_sql = " AND ".join(where)
    txns = conn.execute(
        f"""
        SELECT t.id, p.account_id, t.date, p.amount, t.description,
               (SELECT i.category FROM transaction_items i
                WHERE i.transaction_v2_id = t.id
                ORDER BY i.id LIMIT 1) AS category,
               t.tags
        FROM transactions_v2 t
        JOIN postings p ON p.txn_id = t.id
        WHERE {where_sql}
          AND p.account_id NOT LIKE 'equity:%'
        ORDER BY t.date DESC
        """
    ).fetchall()

    for txn in txns:
        if txn["id"] in paired_ids:
            continue
        stats.processed += 1

        state = {
            "category": txn["category"],
            "subcategory": None,
            "tags": set(),
            "source": None,
        }
        if txn["tags"]:
            state["tags"].update(
                t.strip() for t in txn["tags"].split(",") if t.strip()
            )

        matched_any = False
        for rule in ruleset.rules:
            if all(_eval_condition(c, txn) for c in rule.conditions):
                if not matched_any:
                    state["source"] = rule.name
                    matched_any = True
                stats.rule_hits[rule.name] += 1
                stop = _apply_actions(rule.actions, state)
                if stop:
                    break

        if matched_any:
            stats.matched += 1
            if not dry_run:
                tags_csv = (
                    ",".join(sorted(state["tags"])) if state["tags"] else None
                )
                if state["category"] is not None:
                    # COALESCE(category, ?) preserves any pre-existing item
                    # category (receipt-derived or user-set). The rules pass
                    # only fills in blanks, never clobbers richer provenance.
                    conn.execute(
                        """
                        UPDATE transaction_items
                           SET category = COALESCE(category, ?),
                               category_source = COALESCE(category_source, 'rule')
                         WHERE id = (
                           SELECT MIN(id) FROM transaction_items
                           WHERE transaction_v2_id = ?
                         )
                        """,
                        (state["category"], txn["id"]),
                    )
                if tags_csv:
                    conn.execute(
                        "UPDATE transactions_v2 SET tags = COALESCE(?, tags) "
                        "WHERE id = ?",
                        (tags_csv, txn["id"]),
                    )
        else:
            if len(stats.unmatched_sample) < 15:
                stats.unmatched_sample.append(
                    (txn["amount"], txn["description"])
                )

    # Forward-apply learned rules to anything still uncategorized, so past
    # manual categorizations carry over to newly-synced transactions.
    stats.learned_applied = apply_learned_rules(conn, dry_run)

    return stats


def print_report(stats: CategorizeStats) -> None:
    pct = (stats.matched / stats.processed * 100) if stats.processed else 0.0
    print()
    print(f"processed:        {stats.processed} transactions")
    print(f"transfer pairs:   {stats.transfer_pairs} ({stats.transfer_txns} txns)")
    print(f"rules matched:    {stats.matched} ({pct:.1f}%)")
    print(f"unmatched:        {stats.processed - stats.matched}")
    print(f"learned applied:  {stats.learned_applied}")
    print()
    if stats.rule_hits:
        print("per-rule hits:")
        for name, count in sorted(
            stats.rule_hits.items(), key=lambda kv: (-kv[1], kv[0])
        ):
            print(f"  {count:>4}  {name}")
    if stats.unmatched_sample:
        print()
        print("unmatched sample:")
        for amount, desc in stats.unmatched_sample:
            print(f"  {amount:>10.2f}  {desc}")
