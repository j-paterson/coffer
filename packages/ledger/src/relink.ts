import type { Database } from "bun:sqlite";

// Reconnecting an institution at an aggregator (SimpleFIN) issues brand-new
// account ids for the same real accounts. Without intervention every
// reconnected account shows up twice and the overlapping transaction window
// is ingested a second time. Relinking:
//
//   1. pairs each account that disappeared from the provider's feed
//      ("orphan") with the one new account carrying the same institution and
//      name (names include the last-4, e.g. "Rewards Card (1234)");
//   2. deletes the new account's transactions that duplicate ones already on
//      the orphan: same amount, dates within a few days, matching text once
//      masked digits are ignored, and dated no later than the orphan's last
//      transaction (anything newer can't have been ingested twice). Near
//      misses are listed for review, never deleted;
//   3. merges the new account into the orphan via `merged_into`, so history,
//      overrides and display names carry over and future syncs land on the
//      same canonical account.
//
// Anything ambiguous is reported and left alone. Detection runs on demand;
// applying is a user action (dashboard "Review & merge"), and the server
// backs the database up first.

const DATE_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

export interface RelinkDuplicate {
  txn_id: number;
  /** The existing transaction on the canonical account it duplicates. */
  keeper_txn_id: number;
  date: string;
  description: string | null;
  amount: number;
}

export interface RelinkPair {
  /** Old account, now orphaned — stays canonical. */
  canonical: string;
  /** New account id from the reconnect — becomes an alias. */
  alias: string;
  label: string;
  /** Duplicate transactions (on the alias) to delete. */
  duplicates: RelinkDuplicate[];
  /** Likely duplicates left in place: the text differs, or the transaction
   *  also moves money on an account outside this relink (deleting it would
   *  drop that leg too). */
  needs_review: RelinkDuplicate[];
  /** Alias postings in the overlap window with no counterpart at all. */
  unmatched: number;
}

export interface RelinkPlan {
  pairs: RelinkPair[];
  /** Name collisions with more than one candidate on either side. */
  ambiguous: string[];
}

export interface RelinkOpts {
  /** Account id prefix of the provider, e.g. "simplefin:". */
  prefix: string;
  /** Account ids the provider returned in the latest full sync. */
  seen: ReadonlySet<string>;
  /** Restrict to these alias ids (the pairs a user reviewed). */
  only?: ReadonlySet<string>;
}

type AccountRow = {
  id: string;
  institution: string;
  display_name: string;
  first_as_of: string | null;
  last_as_of: string | null;
  /** Other accounts already merged into this one. */
  aliased_by: number;
};
type PostingRow = { posting_id: number; txn_id: number; date: string; description: string | null; amount: number };

const keyOf = (a: AccountRow) => `${a.institution}\u0000${a.display_name}`;
// Providers mask digits differently across connections ("XXXX4145" vs the
// full number), so compare descriptions with digits and X-runs removed.
const normDesc = (d: string | null) =>
  (d ?? "").toUpperCase().replace(/X{2,}|\d+/g, "").replace(/\s+/g, " ").trim();
const cents = (n: number) => Math.round(n * 100);
const days = (iso: string) => Date.parse(iso.slice(0, 10)) / DAY_MS;

/** Read-only: work out which accounts to relink and which transactions are
 *  duplicates. Apply with `applyRelinkPlan`. */
export function planRelink(db: Database, opts: RelinkOpts): RelinkPlan {
  const accounts = db
    .query(
      `SELECT a.id, a.institution, a.display_name,
              (SELECT MIN(as_of) FROM balance_assertions b WHERE b.account_id = a.id) AS first_as_of,
              (SELECT MAX(as_of) FROM balance_assertions b WHERE b.account_id = a.id) AS last_as_of,
              (SELECT COUNT(*) FROM accounts m WHERE m.merged_into = a.id) AS aliased_by
       FROM accounts a
       WHERE a.id LIKE ? AND a.merged_into IS NULL AND a.active = 1`,
    )
    .all(`${opts.prefix}%`) as AccountRow[];

  const orphansByKey = new Map<string, AccountRow[]>();
  const freshByKey = new Map<string, AccountRow[]>();
  for (const a of accounts) {
    const bucket = opts.seen.has(a.id) ? freshByKey : orphansByKey;
    const k = keyOf(a);
    bucket.set(k, [...(bucket.get(k) ?? []), a]);
  }

  const matchedPairs: { canonical: AccountRow; alias: AccountRow }[] = [];
  const ambiguous: string[] = [];
  for (const [k, orphans] of orphansByKey) {
    const fresh = freshByKey.get(k);
    if (!fresh) continue; // closed or temporarily missing — nothing to relink
    const canonical = orphans[0]!;
    const alias = fresh[0]!;
    const label = `${canonical.institution} · ${canonical.display_name}`;
    if (orphans.length !== 1 || fresh.length !== 1) {
      ambiguous.push(label);
      continue;
    }
    if (opts.only && !opts.only.has(alias.id)) continue;
    // A reconnect means the old account stopped syncing before the new one
    // started. Two real same-name accounts both sync on the same dates, so
    // overlapping balance histories (beyond a day of clock skew) rule a pair
    // out — e.g. when one of them is merely missing from a partial sync.
    const handoff =
      canonical.last_as_of != null &&
      alias.first_as_of != null &&
      days(canonical.last_as_of) <= days(alias.first_as_of) + 1;
    // Something already merged into the alias would end up two hops from
    // its canonical, which the walker doesn't follow.
    if (!handoff || alias.aliased_by > 0) {
      ambiguous.push(label);
      continue;
    }
    matchedPairs.push({ canonical, alias });
  }

  const aliasIds = new Set(matchedPairs.map((p) => p.alias.id));
  const postingsOf = db.query(
    `SELECT p.id AS posting_id, p.txn_id, t.date, t.description, p.amount
     FROM postings p JOIN transactions_v2 t ON t.id = p.txn_id
     WHERE p.account_id = ?
     ORDER BY t.date, p.id`,
  );

  // Pair alias postings 1:1 with canonical ones, best candidates first
  // (globally, not in date order, so one early near-miss can't steal the
  // counterpart of a later exact match).
  const matchedPostings = new Set<number>();
  const fuzzyTxns = new Set<number>();
  const txnAlias = new Map<number, { alias: string; dup: RelinkDuplicate }>();
  const unmatchedByAlias = new Map<string, number>();
  for (const { canonical, alias } of matchedPairs) {
    const old = postingsOf.all(canonical.id) as PostingRow[];
    if (old.length === 0) continue;
    const lastOld = days(old[old.length - 1]!.date);
    // Only the window the orphan could also have ingested.
    const fresh = (postingsOf.all(alias.id) as PostingRow[]).filter((p) => days(p.date) <= lastOld);
    if (fresh.length === 0) continue;
    const floor = days(fresh[0]!.date) - DATE_WINDOW_DAYS;
    const candidates = old.filter((p) => days(p.date) >= floor);

    const edges: { f: PostingRow; o: PostingRow; score: number; fuzzy: boolean }[] = [];
    for (const f of fresh) {
      for (const o of candidates) {
        if (cents(o.amount) !== cents(f.amount)) continue;
        const gap = Math.abs(days(o.date) - days(f.date));
        if (gap > DATE_WINDOW_DAYS) continue;
        // Exact text, then masked-digit-equal text, then anything else.
        const exact = o.description === f.description;
        const fuzzy = !exact && normDesc(o.description) !== normDesc(f.description);
        edges.push({ f, o, score: gap + (exact ? 0 : fuzzy ? 20 : 10), fuzzy });
      }
    }
    edges.sort((a, b) => a.score - b.score || a.f.posting_id - b.f.posting_id);
    const usedOld = new Set<number>();
    for (const { f, o, fuzzy } of edges) {
      if (matchedPostings.has(f.posting_id) || usedOld.has(o.posting_id)) continue;
      usedOld.add(o.posting_id);
      matchedPostings.add(f.posting_id);
      if (fuzzy) fuzzyTxns.add(f.txn_id);
      if (!txnAlias.has(f.txn_id)) {
        txnAlias.set(f.txn_id, {
          alias: alias.id,
          dup: { txn_id: f.txn_id, keeper_txn_id: o.txn_id, date: f.date, description: f.description, amount: f.amount },
        });
      }
    }
    unmatchedByAlias.set(alias.id, fresh.filter((f) => !matchedPostings.has(f.posting_id)).length);
  }

  // A duplicate transaction is deletable only when every real (non-equity)
  // leg is on an alias and matched; otherwise deleting it would also remove
  // money movement on an unrelated account.
  const legsOf = db.query(
    `SELECT id AS posting_id, account_id FROM postings WHERE txn_id = ? AND account_id NOT LIKE 'equity:%'`,
  );
  const pairs: RelinkPair[] = matchedPairs.map(({ canonical, alias }) => ({
    canonical: canonical.id,
    alias: alias.id,
    label: `${canonical.institution} · ${canonical.display_name}`,
    duplicates: [],
    needs_review: [],
    unmatched: unmatchedByAlias.get(alias.id) ?? 0,
  }));
  const pairByAlias = new Map(pairs.map((p) => [p.alias, p]));
  for (const [txnId, { alias, dup }] of txnAlias) {
    const legs = legsOf.all(txnId) as { posting_id: number; account_id: string }[];
    const pair = pairByAlias.get(alias)!;
    const clean = legs.every((l) => aliasIds.has(l.account_id) && matchedPostings.has(l.posting_id));
    if (clean && !fuzzyTxns.has(txnId)) {
      pair.duplicates.push(dup);
    } else {
      pair.needs_review.push(dup);
    }
  }
  const byDate = (a: RelinkDuplicate, b: RelinkDuplicate) => a.date.localeCompare(b.date) || a.txn_id - b.txn_id;
  for (const p of pairs) {
    p.duplicates.sort(byDate);
    p.needs_review.sort(byDate);
  }
  return { pairs, ambiguous };
}

/** Delete the planned duplicates and merge each alias into its canonical,
 *  leaving a `relink` audit note per pair. One SQLite transaction. */
export function applyRelinkPlan(db: Database, plan: RelinkPlan, today: string): void {
  if (plan.pairs.length === 0) return;
  db.transaction(() => {
    for (const p of plan.pairs) {
      for (const d of p.duplicates) {
        // Receipts and user metadata move to the surviving transaction. The
        // raw events stay recorded, so re-syncs still treat them as ingested.
        db.query(`UPDATE emails SET transaction_v2_id = ? WHERE transaction_v2_id = ?`).run(d.keeper_txn_id, d.txn_id);
        db.query(
          `UPDATE transactions_v2 SET
             trip_id = COALESCE(trip_id, (SELECT trip_id FROM transactions_v2 WHERE id = ?1)),
             notes   = COALESCE(notes,   (SELECT notes   FROM transactions_v2 WHERE id = ?1)),
             tags    = COALESCE(tags,    (SELECT tags    FROM transactions_v2 WHERE id = ?1)),
             excluded_from_spending = MAX(excluded_from_spending,
               (SELECT excluded_from_spending FROM transactions_v2 WHERE id = ?1))
           WHERE id = ?2`,
        ).run(d.txn_id, d.keeper_txn_id);
        // Line items: receipt items the keeper lacks move over; every txn
        // also has one synthesized item, and a category the user set on the
        // duplicate's wins over an automatic one on the keeper's.
        db.query(
          `UPDATE transaction_items SET transaction_v2_id = ?1
           WHERE transaction_v2_id = ?2 AND email_id IS NOT NULL
             AND email_id NOT IN (SELECT email_id FROM transaction_items
                                  WHERE transaction_v2_id = ?1 AND email_id IS NOT NULL)`,
        ).run(d.keeper_txn_id, d.txn_id);
        db.query(
          `UPDATE transaction_items AS k SET
             category = u.category, subcategory = u.subcategory,
             short_name = u.short_name, category_source = u.category_source
           FROM (SELECT * FROM transaction_items
                 WHERE transaction_v2_id = ?2 AND email_id IS NULL AND category_source = 'user'
                 ORDER BY line_no LIMIT 1) AS u
           WHERE k.id = (SELECT id FROM transaction_items
                         WHERE transaction_v2_id = ?1 AND email_id IS NULL ORDER BY line_no LIMIT 1)
             AND k.category_source IS NOT 'user'`,
        ).run(d.keeper_txn_id, d.txn_id);
        db.query(`DELETE FROM transaction_items WHERE transaction_v2_id = ?`).run(d.txn_id);
        db.query(`DELETE FROM transactions_v2 WHERE id = ?`).run(d.txn_id); // postings + links cascade
      }
      db.query(`UPDATE accounts SET merged_into = ? WHERE id = ?`).run(p.canonical, p.alias);
      db.query(
        `INSERT INTO reconciliation_notes (account_id, as_of, kind, detail) VALUES (?, ?, 'relink', ?)`,
      ).run(
        p.canonical,
        today,
        JSON.stringify({
          alias: p.alias,
          removed: p.duplicates,
          needs_review: p.needs_review.map((d) => d.txn_id),
        }),
      );
    }
  })();
}

/** Account ids the provider returned in its most recent successful sync
 *  (they share that run's `last_seen_at` stamp). Empty before the first
 *  stamped sync — nothing is relinked until we know the current feed. */
export function latestFeed(db: Database, prefix: string): Set<string> {
  const rows = db
    .query(
      `SELECT id FROM accounts
       WHERE id LIKE ?1
         AND last_seen_at = (SELECT MAX(last_seen_at) FROM accounts WHERE id LIKE ?1)`,
    )
    .all(`${prefix}%`) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
