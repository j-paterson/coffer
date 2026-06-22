"""Ingestion dispatcher and DB write layer.

Takes a ParseResult from any parser and applies it to the SQLite database
with idempotent semantics. Parsers are pure: they read files and return
dataclasses. Only this module touches the DB.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import db, ledger, positions as positions_mod
from .env import load_env
from .parsers import ledger_csv, simplefin
from .parsers.base import ParseResult, TransactionRow


def _holding_source(account_id: str) -> str:
    """Coarse source tag for holdings derived from an account id prefix.
    Per-parser overrides (e.g. zerion-chart vs zerion) need parsers to
    write directly via positions.upsert_holding."""
    for prefix, tag in (
        ("simplefin:", "simplefin"),
        ("zerion:", "zerion"),
        ("alchemy:", "alchemy"),
    ):
        if account_id.startswith(prefix):
            return tag
    return "ingest"


def _source_tag(tx_id: str) -> str:
    """Map a v1-style synthetic txn id prefix to a v2 source tag."""
    for prefix, tag in (
        ("sf:", "simplefin"),
        ("brokerage:", "brokerage"),
        ("schwab:", "schwab"),
        ("ledger:", "ledger-csv"),
        ("synthetic:", "synthetic"),
    ):
        if tx_id.startswith(prefix):
            return tag
    return "ingest"


@dataclass
class WriteCounts:
    accounts: int = 0
    balances: int = 0
    holdings: int = 0
    transactions: int = 0

    def add(self, other: "WriteCounts") -> None:
        self.accounts += other.accounts
        self.balances += other.balances
        self.holdings += other.holdings
        self.transactions += other.transactions

    def as_dict(self) -> dict[str, int]:
        return {
            "accounts": self.accounts,
            "balances": self.balances,
            "holdings": self.holdings,
            "transactions": self.transactions,
        }


def write_result(result: ParseResult) -> WriteCounts:
    """Apply a ParseResult to the database.

    - accounts: upsert by id (latest metadata wins)
    - balances: idempotent by composite PK
    - holdings: replace by composite PK (handles intra-snapshot corrections)
    """
    counts = WriteCounts()
    with db.connect() as conn:
        for a in result.accounts:
            conn.execute(
                """
                INSERT INTO accounts (id, display_name, institution, type, currency, active, mode)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    display_name = excluded.display_name,
                    institution  = excluded.institution,
                    type         = excluded.type,
                    currency     = excluded.currency,
                    active       = excluded.active,
                    mode         = excluded.mode
                """,
                (
                    a.id,
                    a.display_name,
                    a.institution,
                    a.type,
                    a.currency,
                    a.active,
                    a.mode,
                ),
            )
            counts.accounts += 1

        for b in result.balances:
            # Idempotent on (account_id, as_of, source).
            ledger.assert_balance(
                conn,
                account_id=b.account_id,
                as_of=b.as_of,
                expected_usd=b.value_usd,
                source=b.source,
            )
            counts.balances += 1

        for h in result.holdings:
            # Source tag derived from account-id prefix (e.g. "zerion:",
            # "simplefin:").
            positions_mod.upsert_holding(
                conn,
                account_id=h.account_id,
                symbol=h.symbol,
                as_of=h.as_of,
                source=_holding_source(h.account_id),
                value_usd=h.value_usd,
                quantity=h.quantity,
                asset_class=h.asset_class,
                cost_basis=h.cost_basis,
            )
            counts.holdings += 1

        for tx in result.transactions:
            if _mirror_v2_txn(conn, tx):
                counts.transactions += 1

    return counts


def _mirror_v2_txn(conn, tx: TransactionRow) -> bool:
    """Append a v2 transaction. Idempotent via raw_events
    UNIQUE(source, external_id); returns False if the event was already
    recorded in a prior run."""
    source = _source_tag(tx.id)
    raw_id = ledger.record_event(
        conn,
        source=source,
        external_id=tx.id,
        payload={
            "date": tx.date,
            "amount": tx.amount,
            "description": tx.description,
            "account_id": tx.account_id,
            "category": tx.category,
            "merchant": tx.merchant,
            "payee": tx.payee,
            "memo": tx.memo,
        },
        source_file=tx.source_file,
    )
    if raw_id is None:
        return False
    ledger.post_transaction(
        conn,
        date=tx.date,
        description=tx.description,
        postings=ledger.one_sided(
            account_id=tx.account_id,
            amount=tx.amount,
            payee=tx.payee,
            memo=tx.memo,
        ),
        raw_ids=(raw_id,),
        derived_by="ingest",
        category=tx.category,
        notes=tx.notes,
    )
    return True


def ingest_ledger_operations(
    path: Path, dry_run: bool = False
) -> WriteCounts:
    """Ingest a Ledger Live operations CSV. Matches each row to an
    existing zerion:<chain>:<addr> account; unmapped wallets are reported
    so the user can add them to the Zerion sync."""
    total = WriteCounts()
    if not path.exists():
        print(f"no such file: {path}")
        return total
    with db.connect() as conn:
        result, stats = ledger_csv.parse(path, conn)
    print(f"parsing ledger operations: {path.name}")
    ledger_csv.print_stats(stats)
    if dry_run or not result.transactions:
        return total
    counts = write_result(result)
    total.add(counts)
    print(f"\nwrote {counts.transactions} transactions")
    return total


SIMPLEFIN_DAILY_QUOTA = 12  # max calls per UTC day; SimpleFIN data refreshes daily


def sync_simplefin(start_days: int = 365, force: bool = False, _emit_run_brackets: bool = True) -> WriteCounts:
    """Fetch live data from SimpleFIN and write to the database.

    SimpleFIN data only refreshes once a day on their side, and the
    provider has actively warned about excessive requests. Enforces a
    daily quota (UTC) of SIMPLEFIN_DAILY_QUOTA calls; further calls are
    skipped unless force=True. Each call is logged to provider_cache so
    the count survives restarts.

    When `_emit_run_brackets=False`, the caller is responsible for emitting
    `sync_started`/`sync_finished` (used by `finance sync all` to wrap the
    whole run in one bracket).
    """
    from datetime import datetime, timezone
    import uuid
    from . import events

    run_id = uuid.uuid4().hex
    if _emit_run_brackets:
        events.sync_started(run_id=run_id, sources=["simplefin"])

    try:
        env = load_env()
        access_url = env.get("SIMPLEFIN_ACCESS_URL")
        if not access_url:
            raise RuntimeError(
                "SIMPLEFIN_ACCESS_URL not set in .env — run the token exchange first"
            )

        today_utc = datetime.now(timezone.utc).date().isoformat()
        if not force:
            with db.connect() as conn:
                count_today = conn.execute(
                    """
                    SELECT COUNT(*) FROM provider_cache
                    WHERE source = 'simplefin:accounts'
                      AND substr(fetched_at, 1, 10) = ?
                    """,
                    (today_utc,),
                ).fetchone()[0]
            if count_today >= SIMPLEFIN_DAILY_QUOTA:
                print(
                    f"skipping SimpleFIN sync — {count_today} calls already today "
                    f"(daily quota: {SIMPLEFIN_DAILY_QUOTA}; --force to override)"
                )
                if _emit_run_brackets:
                    events.sync_finished(
                        run_id=run_id,
                        ok=False,
                        totals={"accounts": 0, "balances": 0, "transactions": 0},
                    )
                return WriteCounts()

        print(f"fetching /accounts (last {start_days} days, pending excluded)")
        data = simplefin.fetch_accounts(access_url, start_days=start_days)
        with db.connect() as conn:
            # Append-style insert (one row per call) so we can count today's
            # calls. Subject is the call ISO so each row is distinct.
            conn.execute(
                "INSERT INTO provider_cache (source, subject, fetched_at) "
                "VALUES (?, ?, ?)",
                ("simplefin:accounts",
                 datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 datetime.now(timezone.utc).isoformat(timespec="seconds")),
            )
            conn.commit()

        result = simplefin.parse(data)
        for w in result.warnings:
            print(f"  warning: {w}")
            events.warning(account_id=None, message=w)

        # SimpleFIN is one bulk fetch — emit account_started for every parsed
        # account before write_result, so the UI shows them all as "fetching"
        # in unison.
        seen_account_ids: list[str] = []
        for account in result.accounts:
            events.account_started(account_id=account.id, source="simplefin")
            seen_account_ids.append(account.id)

        counts = write_result(result)
        print(
            f"  accounts={counts.accounts} balances={counts.balances} "
            f"transactions={counts.transactions}"
        )
        for aid in seen_account_ids:
            events.account_log(account_id=aid, message=f"wrote postings for {aid}")
            events.account_finished(account_id=aid, ok=True)

        if _emit_run_brackets:
            events.sync_finished(
                run_id=run_id,
                ok=True,
                totals={
                    "accounts": counts.accounts,
                    "balances": counts.balances,
                    "transactions": counts.transactions,
                },
            )
        return counts
    except Exception:
        if _emit_run_brackets:
            events.sync_finished(
                run_id=run_id,
                ok=False,
                totals={"accounts": 0, "balances": 0, "transactions": 0},
            )
        raise
