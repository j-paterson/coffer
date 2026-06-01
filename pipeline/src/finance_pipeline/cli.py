"""finance CLI entry point."""
from __future__ import annotations

import argparse
import sys

from pathlib import Path

from . import backfill_crypto
from . import backfill_prices
from . import backup as backup_mod
from . import categorize as categorize_mod
from . import db, ingest
from . import trips as trips_mod
from .config import RULES_PATH

try:
    from .emails import aggregate as email_aggregate
    from .emails import classify as email_classify
    from .emails import classify_kind as email_classify_kind
    from .emails import extract as email_extract
    from .emails import fetcher as email_fetcher
    from .emails import match as email_match
    from .emails import merchant_lookup
    from .emails import shorten as email_shorten
    _EMAIL_AVAILABLE = True
except ImportError:
    _EMAIL_AVAILABLE = False


def cmd_migrate(_args: argparse.Namespace) -> int:
    applied = db.migrate()
    if applied:
        for version in applied:
            print(f"applied {version}")
    else:
        print("no pending migrations")
    return 0


def _post_crypto_sync() -> None:
    """Fill asset_prices + position_snapshots gaps after a crypto sync.

    - ``backfill defillama`` (incremental): one request per coin to
      fetch today's price, so the Coinbase snapshot path has a fresh
      entry to price against. 24h cache + per-coin latest-stored check
      makes repeat runs cheap.
    - ``backfill crypto``: Zerion fungible-chart per-symbol history,
      24h cached. Fills position_snapshots for EVM wallets.
    """
    print()
    print("backfill: asset_prices + wallet holdings...")
    try:
        from . import backfill_defillama
        st = backfill_defillama.backfill()
        backfill_defillama.print_report(st)
    except Exception as e:
        print(f"  defillama: {e}")
    try:
        st = backfill_crypto.backfill_crypto()
        backfill_crypto.print_report(st)
    except Exception as e:
        print(f"  crypto: {e}")


def _post_brokerage_sync() -> None:
    """Fill historical equity/brokerage prices after a SimpleFIN sync.
    Yahoo Finance, 0.6s/symbol, idempotent."""
    print()
    print("backfill: equity prices...")
    try:
        st = backfill_prices.backfill_investments()
        backfill_prices.print_report(st)
    except Exception as e:
        print(f"  prices: {e}")


def _post_write_reconcile() -> None:
    """Collapse cross-source duplicates + re-pair transfers after any
    sync/ingest that writes to transactions_v2. Idempotent by design
    — a clean run is a no-op. Runs silently unless it actually did
    work, so quiet sources don't spam the terminal."""
    from . import reconcile as _rc
    with db.connect() as conn:
        stats = _rc.dedup_transactions(conn)
        pairs = categorize_mod.find_transfer_pairs(conn)
        if pairs:
            categorize_mod.apply_transfer_pairs(conn, pairs)
            relinked = categorize_mod.relink_transfer_counterparties(conn, pairs)
        else:
            relinked = 0
        conn.commit()
    if stats.merged_losers:
        print(
            f"reconcile: merged {stats.merged_losers} cross-source "
            f"duplicate txn(s) into canonicals"
        )
    if relinked:
        print(
            f"reconcile: relinked {relinked} transfer pair(s) "
            f"to real counterparty accounts"
        )


def cmd_ingest(args: argparse.Namespace) -> int:
    source = args.source
    if source == "ledger-ops":
        if not args.path:
            print("ledger-ops requires --path to the operations CSV")
            return 1
        total = ingest.ingest_ledger_operations(
            Path(args.path), dry_run=args.dry_run
        )
    else:
        print(f"unknown source: {source}")
        return 1
    print(f"\ntotal: {total.as_dict()}")
    _post_write_reconcile()
    return 0


_TS_SYNC_SOURCES = frozenset({"simplefin", "zerion", "alchemy", "coinbase", "all"})


def _warn_legacy_python_sync(source: str) -> None:
    if source not in _TS_SYNC_SOURCES:
        return
    print(
        "warning: `finance sync` for live API sources is deprecated. "
        "Use the dashboard or `bun apps/cli/src/index.ts sync <parser-id>` "
        "(see finance.config.ts). Python sync may write different account ids "
        "than the TypeScript parsers.",
        file=sys.stderr,
    )


def cmd_sync(args: argparse.Namespace) -> int:
    from . import events
    events.init(getattr(args, "events_fd", None))
    source = args.source
    _warn_legacy_python_sync(source)
    if source == "all":
        import uuid
        from .parsers import zerion, alchemy

        run_id = uuid.uuid4().hex
        events.sync_started(run_id=run_id, sources=["simplefin", "zerion"])
        totals: dict = {}
        ok = False
        sf_ok = False
        try:
            # SimpleFIN
            sf_counts = ingest.sync_simplefin(
                start_days=args.days, force=getattr(args, "force", False),
                _emit_run_brackets=False,
            )
            sf_ok = True
            totals["simplefin"] = sf_counts.as_dict()
            _post_write_reconcile()
            _post_brokerage_sync()

            # Zerion
            z_stats = zerion.sync(_emit_run_brackets=False)
            totals["zerion"] = {
                "errors": z_stats.errors,
                "wallets": z_stats.wallets,
                "accounts": z_stats.accounts,
            }
            zerion_hollow = z_stats.errors > 0 or z_stats.accounts == 0

            # Alchemy fallback only when Zerion produced no accounts or errored
            if zerion_hollow:
                a_stats = alchemy.sync(_emit_run_brackets=False)
                totals["alchemy"] = {"errors": a_stats.errors}
                ok = sf_ok and a_stats.errors == 0
            else:
                ok = sf_ok and z_stats.errors == 0

            _post_write_reconcile()
            _post_crypto_sync()
        finally:
            events.sync_finished(run_id=run_id, ok=ok, totals=totals)
        return 0
    if source == "simplefin":
        total = ingest.sync_simplefin(
            start_days=args.days, force=getattr(args, "force", False)
        )
        print(f"\ntotal: {total.as_dict()}")
        _post_write_reconcile()
        _post_brokerage_sync()
        return 0
    if source == "email":
        if not _EMAIL_AVAILABLE:
            print(
                "error: email sync requires the [email] extras. "
                "Run: pip install -e ./pipeline[email]",
                file=sys.stderr,
            )
            return 1
        stats = email_fetcher.sync(
            query=args.query or email_fetcher.DEFAULT_QUERY,
            max_results=args.max_results,
        )
        email_fetcher.print_report(stats)
        return 0
    if source == "zerion":
        from .parsers import zerion
        stats = zerion.sync()
        zerion.print_report(stats)
        _post_write_reconcile()
        _post_crypto_sync()
        return 0
    if source == "alchemy":
        from .parsers import alchemy
        if args.from_cache:
            from . import backfill_alchemy_history
            print("note: --from-cache replays cached alchemy-history transfers")
            stats = backfill_alchemy_history.replay()
            backfill_alchemy_history.print_report(stats)
            _post_crypto_sync()
            return 0
        stats = alchemy.sync()
        alchemy.print_report(stats)
        _post_write_reconcile()
        _post_crypto_sync()
        return 0
    if source == "coinbase":
        from .parsers import coinbase_direct
        if args.from_cache:
            stats = coinbase_direct.replay()
        else:
            stats = coinbase_direct.sync()
        coinbase_direct.print_report(stats)
        if not args.from_cache:
            _post_write_reconcile()
        _post_crypto_sync()
        return 0
    print(f"unknown source: {source}")
    return 1


def cmd_categorize(args: argparse.Namespace) -> int:
    rules_path = Path(args.rules) if args.rules else RULES_PATH
    stats = categorize_mod.categorize(
        rules_path=rules_path,
        dry_run=args.dry_run,
        only_uncategorized=args.uncategorized,
    )
    categorize_mod.print_report(stats)
    if args.dry_run:
        print("\n(dry-run — no changes written)")
    return 0


def cmd_reconcile(args: argparse.Namespace) -> int:
    from . import db as _db
    from . import reconcile as _rc
    sub = args.action
    if sub == "dedup":
        with _db.connect() as conn:
            stats = _rc.dedup_transactions(
                conn, window_days=args.window_days, dry_run=args.dry_run,
            )
            if not args.dry_run:
                conn.commit()
        _rc.print_dedup_report(stats)
        if args.dry_run:
            print("\n(dry-run — no changes written)")
        return 0
    if sub == "transfers":
        from . import categorize as _cat
        with _db.connect() as conn:
            pairs = _cat.find_transfer_pairs(conn, window_days=args.window_days)
            print(f"transfer pairs: {len(pairs)}")
            for id_a, id_b, amt in pairs[:20]:
                print(f"  v2:{id_a:<8} ↔ v2:{id_b:<8}  ${amt:,.2f}")
            if len(pairs) > 20:
                print(f"  …and {len(pairs) - 20} more")
            if not args.dry_run and pairs:
                _cat.apply_transfer_pairs(conn, pairs)
                relinked = _cat.relink_transfer_counterparties(conn, pairs)
                conn.commit()
                print(f"tagged {len(pairs) * 2} txns as Transfer / transfer-pair")
                print(f"relinked {relinked} pair(s) to real counterparty accounts")
        if args.dry_run:
            print("\n(dry-run — no changes written)")
        return 0
    print(f"unknown reconcile action: {sub}")
    return 1


def cmd_ledger(args: argparse.Namespace) -> int:
    sub = args.action
    if sub == "validate":
        from . import validate as v
        rpt = v.run(tolerance_usd=args.tolerance)
        v.print_report(rpt)
        return 0
    if sub == "assert":
        from . import db as _db
        from . import ledger as _lg
        with _db.connect() as conn:
            # Reactivate if the account was archived (common for manual
            # entries like property that got soft-deleted).
            conn.execute(
                "UPDATE accounts SET active = 1 WHERE id = ?", (args.account_id,)
            )
            _lg.assert_balance(
                conn,
                account_id=args.account_id,
                as_of=args.as_of,
                expected_usd=args.amount,
                source=args.source,
                source_file=args.source_file,
            )
            conn.commit()
        print(
            f"asserted {args.account_id} @ {args.as_of}: "
            f"${args.amount:,.2f} [{args.source}]"
        )
        return 0
    print(f"unknown ledger action: {sub}")
    return 1




def cmd_accounts(args: argparse.Namespace) -> int:
    from . import db as _db
    from . import reconcile as _rc
    sub = args.action
    if sub == "merge":
        with _db.connect() as conn:
            row = conn.execute(
                "SELECT id, merged_into FROM accounts WHERE id = ?",
                (args.canonical_id,),
            ).fetchone()
            if row is None:
                print(f"canonical account not found: {args.canonical_id}")
                return 1
            if row[1] is not None:
                print(
                    f"refuse: {args.canonical_id} is itself merged into {row[1]} "
                    f"— pick the chain head instead"
                )
                return 1
            cur = conn.execute(
                "UPDATE accounts SET merged_into = ? WHERE id = ? AND merged_into IS NULL",
                (args.canonical_id, args.alias_id),
            )
            if cur.rowcount == 0:
                print(f"no change: {args.alias_id} not found or already merged")
                return 1
            conn.commit()
        print(f"merged {args.alias_id} → {args.canonical_id}")
        return 0
    if sub == "unmerge":
        with _db.connect() as conn:
            cur = conn.execute(
                "UPDATE accounts SET merged_into = NULL WHERE id = ?",
                (args.alias_id,),
            )
            conn.commit()
        print(f"cleared merge on {args.alias_id} ({cur.rowcount} row)")
        return 0
    if sub == "suggest-merges":
        with _db.connect() as conn:
            matches = _rc.find_matches(conn)
        if not matches:
            print("no merge candidates")
            return 0
        print(f"{len(matches)} candidates (review and run "
              f"`finance accounts merge <alias> <canonical>`):")
        for m in matches:
            print(
                f"  {m.manual_id[:55]:<57} → {m.live_id[:55]:<57}  "
                f"[{m.matched_on}]"
            )
            print(
                f"    {m.manual_name[:55]:<57}    {m.live_name[:55]}"
            )
        return 0
    if sub == "list-merged":
        with _db.connect() as conn:
            rows = conn.execute(
                """
                SELECT a.id, a.display_name, a.merged_into,
                       b.display_name AS canonical_name
                FROM accounts a LEFT JOIN accounts b ON b.id = a.merged_into
                WHERE a.merged_into IS NOT NULL
                ORDER BY a.merged_into, a.id
                """
            ).fetchall()
        if not rows:
            print("no merged accounts")
            return 0
        for r in rows:
            print(f"  {r[0][:55]:<57} → {r[2][:55]}")
            print(f"    {r[1][:55]:<57}    {r[3] or ''}")
        return 0
    print(f"unknown accounts action: {sub}")
    return 1


def cmd_sources(args: argparse.Namespace) -> int:
    from . import db as _db
    sub = args.action
    with _db.connect() as conn:
        if sub == "list":
            print(f"{'name':<25} {'kind':<10} {'rank':>4} {'enabled':>7}  notes")
            for r in conn.execute(
                "SELECT name, kind, trust_rank, enabled, COALESCE(notes,'') "
                "FROM data_sources ORDER BY kind, trust_rank"
            ):
                print(f"  {r[0]:<23} {r[1]:<10} {r[2]:>4}  {r[3]:>5}    {r[4]}")
            return 0
        if sub == "toggle":
            kind_clause = ""
            params = [args.name]
            if args.kind:
                kind_clause = " AND kind = ?"
                params.append(args.kind)
            cur = conn.execute(
                f"UPDATE data_sources SET enabled = 1 - enabled "
                f"WHERE name = ?{kind_clause}",
                params,
            )
            conn.commit()
            if cur.rowcount == 0:
                print(f"no data source named {args.name!r}"
                      + (f" with kind={args.kind!r}" if args.kind else ""))
                return 1
            for r in conn.execute(
                "SELECT name, kind, enabled FROM data_sources "
                "WHERE name = ?" + kind_clause, params
            ):
                print(f"  {r[0]:<23} {r[1]:<10} enabled={r[2]}")
            return 0
        if sub == "rank":
            conn.execute(
                "UPDATE data_sources SET trust_rank = ? WHERE name = ? AND kind = ?",
                (args.new_rank, args.name, args.kind),
            )
            conn.commit()
            print(f"set {args.name}/{args.kind} trust_rank = {args.new_rank}")
            return 0
    print(f"unknown sources action: {sub}")
    return 1


def cmd_backfill(args: argparse.Namespace) -> int:
    what = args.what
    if what == "prices":
        stats = backfill_prices.backfill_investments(days=args.days)
        backfill_prices.print_report(stats)
        return 0
    if what == "crypto":
        stats = backfill_crypto.backfill_crypto(days=args.days)
        backfill_crypto.print_report(stats)
        return 0
    if what == "coingecko":
        from . import backfill_coingecko
        stats = backfill_coingecko.backfill(days_back=args.days * 9 if args.days < 365 else args.days)
        backfill_coingecko.print_report(stats)
        return 0
    if what == "defillama":
        from . import backfill_defillama
        stats = backfill_defillama.backfill()
        backfill_defillama.print_report(stats)
        return 0
    if what == "alchemy-history":
        from . import backfill_alchemy_history
        if args.from_cache:
            stats = backfill_alchemy_history.replay()
        else:
            stats = backfill_alchemy_history.backfill()
        backfill_alchemy_history.print_report(stats)
        return 0
    if what == "dex-basis":
        from . import backfill_dex_basis
        stats = backfill_dex_basis.backfill()
        backfill_dex_basis.print_report(stats)
        return 0
    print(f"unknown backfill target: {what}")
    return 1


def cmd_backup(args: argparse.Namespace) -> int:
    backup_mod.backup(keep=args.keep)
    return 0


def cmd_extract_email(args: argparse.Namespace) -> int:
    stats = email_extract.extract_pending(limit=args.limit)
    email_extract.print_report(stats)
    return 0


def cmd_match_email(args: argparse.Namespace) -> int:
    stats = email_match.match_all(refresh=args.refresh)
    email_match.print_report(stats)
    return 0


def cmd_classify_items(args: argparse.Namespace) -> int:
    stats = email_classify.classify_all(only_uncategorized=not args.refresh)
    email_classify.print_report(stats)
    return 0


def cmd_classify_kind(args: argparse.Namespace) -> int:
    items = email_classify_kind.KindStats()
    txns = email_classify_kind.KindStats()
    if not args.txns_only:
        items = email_classify_kind.classify_items(
            only_unclassified=not args.refresh,
        )
    if not args.items_only:
        txns = email_classify_kind.classify_txns(
            only_unclassified=not args.refresh,
            only_bundled=not args.all_txns,
        )
    email_classify_kind.print_report(items, txns)
    return 0


def cmd_classify_merchants(_args: argparse.Namespace) -> int:
    stats = merchant_lookup.classify_merchants()
    merchant_lookup.print_report(stats)
    return 0


def cmd_shorten_items(args: argparse.Namespace) -> int:
    stats = email_shorten.shorten_all(limit=args.limit)
    email_shorten.print_report(stats)
    return 0


def cmd_aggregate_categories(_args: argparse.Namespace) -> int:
    stats = email_aggregate.aggregate_all()
    email_aggregate.print_report(stats)
    return 0


def cmd_detect_trips(args: argparse.Namespace) -> int:
    detected = trips_mod.detect_trips(
        gap_days=args.gap_days, dry_run=args.dry_run,
    )
    trips_mod.print_report(detected)
    if args.dry_run:
        print("\n(dry-run — no changes written)")
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    with db.connect() as conn:
        versions = sorted(db.applied_versions(conn))
    if versions:
        print("applied migrations:")
        for v in versions:
            print(f"  {v}")
    else:
        print("no migrations applied")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="finance")
    sub = parser.add_subparsers(dest="command", required=True)

    p_migrate = sub.add_parser("migrate", help="Apply pending SQL migrations")
    p_migrate.set_defaults(func=cmd_migrate)

    p_status = sub.add_parser("status", help="Show applied migrations")
    p_status.set_defaults(func=cmd_status)

    p_ingest = sub.add_parser("ingest", help="Ingest data from a CSV file")
    p_ingest.add_argument(
        "source",
        choices=["ledger-ops"],
        help="Data source to ingest",
    )
    p_ingest.add_argument(
        "--path",
        default=None,
        help="Explicit file path to the CSV",
    )
    p_ingest.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and show what would be written, but don't modify the DB",
    )
    p_ingest.set_defaults(func=cmd_ingest)

    p_sync = sub.add_parser("sync", help="Sync live data from an API source")
    p_sync.add_argument(
        "source",
        choices=["simplefin", "email", "zerion", "alchemy", "coinbase", "all"],
        help="Live data source",
    )
    p_sync.add_argument(
        "--days",
        type=int,
        default=365,
        help="SimpleFIN: how many days back to fetch (default: 365)",
    )
    p_sync.add_argument(
        "--query",
        type=str,
        default=None,
        help="Email: Gmail search query (default: receipt-style subjects)",
    )
    p_sync.add_argument(
        "--max-results",
        type=int,
        default=100,
        help="Email: max messages to fetch per run (default: 100)",
    )
    p_sync.add_argument(
        "--force",
        action="store_true",
        help="SimpleFIN: bypass the 22-hour cache (provider data only "
             "refreshes once daily; use sparingly)",
    )
    p_sync.add_argument(
        "--events-fd",
        type=int,
        default=None,
        help="File descriptor for JSON-lines event emission (used by the dashboard API).",
    )
    p_sync.add_argument(
        "--from-cache",
        action="store_true",
        help="alchemy/coinbase: replay cached raw_events instead of "
             "hitting the API. Use after a price backfill or snapshot-"
             "writing logic change to refresh derived snapshots without "
             "burning API budget.",
    )
    p_sync.set_defaults(func=cmd_sync)

    p_cat = sub.add_parser(
        "categorize",
        help="Apply rules.yaml categorization to transactions",
    )
    p_cat.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without writing to the DB",
    )
    p_cat.add_argument(
        "--rules",
        type=str,
        default=None,
        help="Path to rules YAML (default: pipeline/rules.yaml)",
    )
    p_cat.add_argument(
        "--uncategorized",
        action="store_true",
        help="Only process transactions with no existing category",
    )
    p_cat.set_defaults(func=cmd_categorize)

    if _EMAIL_AVAILABLE:
        p_extract = sub.add_parser(
            "extract-email",
            help="Run NuExtract on pending emails and write receipt fields",
        )
        p_extract.add_argument(
            "--limit",
            type=int,
            default=50,
            help="Max pending emails to process in this run (default: 50)",
        )
        p_extract.set_defaults(func=cmd_extract_email)

        p_match = sub.add_parser(
            "match-email",
            help="Match extracted email receipts to transactions",
        )
        p_match.add_argument(
            "--refresh",
            action="store_true",
            help="Re-match already-matched emails (default: only unmatched)",
        )
        p_match.set_defaults(func=cmd_match_email)

        p_classify = sub.add_parser(
            "classify-items",
            help="Tag transaction_items with a keyword-based category",
        )
        p_classify.add_argument(
            "--refresh",
            action="store_true",
            help="Re-classify items that already have a category (default: only NULL)",
        )
        p_classify.set_defaults(func=cmd_classify_items)

        p_classify_kind = sub.add_parser(
            "classify-kind",
            help="Tag transaction_items + transactions_v2 as material/labor",
        )
        p_classify_kind.add_argument(
            "--refresh",
            action="store_true",
            help="Re-classify rows that already have a kind (default: only NULL)",
        )
        p_classify_kind.add_argument(
            "--items-only",
            action="store_true",
            help="Classify line items only, skip whole-transaction pass",
        )
        p_classify_kind.add_argument(
            "--txns-only",
            action="store_true",
            help="Classify whole transactions only, skip line items",
        )
        p_classify_kind.add_argument(
            "--all-txns",
            action="store_true",
            help="Classify every unitemized txn, not just those inside a bundle",
        )
        p_classify_kind.set_defaults(func=cmd_classify_kind)

        p_merchants = sub.add_parser(
            "classify-merchants",
            help="Classify merchants by fetching their homepage and asking an LLM",
        )
        p_merchants.set_defaults(func=cmd_classify_merchants)

        p_shorten = sub.add_parser(
            "shorten-items",
            help="Use a local LLM to shorten long product titles into concise labels",
        )
        p_shorten.add_argument(
            "--limit",
            type=int,
            default=500,
            help="Max items to process in one run (default: 500)",
        )
        p_shorten.set_defaults(func=cmd_shorten_items)

        p_aggregate = sub.add_parser(
            "aggregate-categories",
            help="Cluster fine-grained subcategories into broad canonical categories via LLM",
        )
        p_aggregate.set_defaults(func=cmd_aggregate_categories)

    p_trips = sub.add_parser(
        "detect-trips",
        help="Cluster Travel-categorized transactions into trips",
    )
    p_trips.add_argument(
        "--gap-days",
        type=int,
        default=4,
        help="Max days between consecutive Travel txns in the same trip (default: 4)",
    )
    p_trips.add_argument(
        "--dry-run",
        action="store_true",
        help="Show detected trips without writing to the DB",
    )
    p_trips.set_defaults(func=cmd_detect_trips)

    p_lg = sub.add_parser(
        "ledger", help="Double-entry (v2) schema operations"
    )
    lg_sub = p_lg.add_subparsers(dest="action", required=True)
    p_lg_v = lg_sub.add_parser("validate", help="Check balance assertions against postings")
    p_lg_v.add_argument("--tolerance", type=float, default=5.0, help="Max USD delta considered clean (default 5)")
    p_lg_v.set_defaults(func=cmd_ledger)
    p_lg_a = lg_sub.add_parser(
        "assert",
        help="Record a manual balance assertion",
    )
    p_lg_a.add_argument("account_id")
    p_lg_a.add_argument("as_of", help="ISO date, e.g. 2026-01-01")
    p_lg_a.add_argument("amount", type=float, help="Expected balance in USD")
    p_lg_a.add_argument("--source", default="manual", help="Source tag (default: manual)")
    p_lg_a.add_argument("--source-file", default=None, help="Optional source-file reference")
    p_lg_a.set_defaults(func=cmd_ledger)

    p_rc = sub.add_parser(
        "reconcile",
        help="Cross-source cleanup: dedup collapsed pairs, tag transfers",
    )
    rc_sub = p_rc.add_subparsers(dest="action", required=True)
    p_rc_d = rc_sub.add_parser(
        "dedup",
        help="Collapse cross-source duplicate v2 txns into a single canonical id",
    )
    p_rc_d.add_argument(
        "--window-days", type=int, default=3,
        help="Max date delta for duplicate candidates (default: 3)",
    )
    p_rc_d.add_argument(
        "--dry-run", action="store_true",
        help="Show cluster count without writing",
    )
    p_rc_d.set_defaults(func=cmd_reconcile)
    p_rc_t = rc_sub.add_parser(
        "transfers",
        help="Detect and tag inter-account transfer pairs",
    )
    p_rc_t.add_argument(
        "--window-days", type=int, default=5,
        help="Max date delta between mirrored legs (default: 5)",
    )
    p_rc_t.add_argument(
        "--dry-run", action="store_true",
        help="Print pairs without tagging",
    )
    p_rc_t.set_defaults(func=cmd_reconcile)

    p_acct = sub.add_parser(
        "accounts", help="Account-level operations (merge, list, suggest)"
    )
    acct_sub = p_acct.add_subparsers(dest="action", required=True)
    p_acct_m = acct_sub.add_parser("merge", help="Mark alias_id as a merge of canonical_id")
    p_acct_m.add_argument("alias_id")
    p_acct_m.add_argument("canonical_id")
    p_acct_m.set_defaults(func=cmd_accounts)
    p_acct_u = acct_sub.add_parser("unmerge", help="Clear merged_into on alias_id")
    p_acct_u.add_argument("alias_id")
    p_acct_u.set_defaults(func=cmd_accounts)
    p_acct_s = acct_sub.add_parser(
        "suggest-merges",
        help="List candidate merges from heuristics (does NOT apply them)",
    )
    p_acct_s.set_defaults(func=cmd_accounts)
    p_acct_l = acct_sub.add_parser("list-merged", help="Show currently-merged accounts")
    p_acct_l.set_defaults(func=cmd_accounts)
    p_src = sub.add_parser(
        "sources", help="Manage data sources (enable/disable, re-rank)"
    )
    src_sub = p_src.add_subparsers(dest="action", required=True)
    p_src_l = src_sub.add_parser("list", help="Show all data sources")
    p_src_l.set_defaults(func=cmd_sources)
    p_src_t = src_sub.add_parser("toggle", help="Flip enabled flag")
    p_src_t.add_argument("name", help="Source name (e.g. simplefin)")
    p_src_t.add_argument("--kind", choices=["assertion", "snapshot"],
                         help="Restrict to one kind (default: both)")
    p_src_t.set_defaults(func=cmd_sources)
    p_src_r = src_sub.add_parser("rank", help="Update trust_rank")
    p_src_r.add_argument("name")
    p_src_r.add_argument("kind", choices=["assertion", "snapshot"])
    p_src_r.add_argument("new_rank", type=int)
    p_src_r.set_defaults(func=cmd_sources)

    p_bf = sub.add_parser(
        "backfill",
        help="Synthesize historical data from external sources",
    )
    p_bf.add_argument(
        "what",
        choices=["prices", "crypto", "coingecko", "defillama", "alchemy-history", "dex-basis"],
        help=(
            "prices: daily equity closes × current holdings; "
            "crypto: Zerion fungible charts × current positions"
        ),
    )
    p_bf.add_argument(
        "--days", type=int, default=365, help="Window in days (default 365)"
    )
    p_bf.add_argument(
        "--from-cache",
        action="store_true",
        help="alchemy-history: replay cached transfers from raw_events "
             "instead of re-fetching from Alchemy.",
    )
    p_bf.set_defaults(func=cmd_backfill)

    p_bk = sub.add_parser(
        "backup",
        help="Write a gzipped SQL dump of the database to backups/",
    )
    p_bk.add_argument(
        "--keep",
        type=int,
        default=30,
        help="Number of recent backups to keep (older ones pruned, default: 30)",
    )
    p_bk.set_defaults(func=cmd_backup)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
