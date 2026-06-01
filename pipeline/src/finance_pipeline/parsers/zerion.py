"""Zerion crypto sync.

Pulls positions for each known EVM wallet from the Zerion API and writes
them into the ledger's `accounts` / `balances` / `holdings` tables —
same shape as any other live data source, matching the SimpleFIN
pattern.

Covers: Ethereum, Base, Arbitrum, Polygon, Optimism, and other EVM
chains Zerion tracks for a given address. Each (wallet_address, chain)
pair becomes one account row, so the dashboard can show "MetaMask on
Ethereum" and "MetaMask on Base" as distinct balances despite sharing
the same address.

Does not cover Cosmos, Solana, Sui, Near, or centralized exchanges —
those stay on manual snapshots until a dedicated provider is added.

Wallet addresses come from the `ZERION_WALLETS` env var (comma-separated).
"""
from __future__ import annotations

import base64
import json
import re
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .. import events
from .. import ledger
from .. import positions as positions_mod
from ..db import connect
from ..env import load_env

ZERION_API_BASE = "https://api.zerion.io/v1"
ETH_ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")


from ..cache import mark_fetched as _cache_mark, was_fetched_within as _cache_hit  # noqa: E402


@dataclass
class ZerionStats:
    wallets: int = 0
    accounts: int = 0
    positions: int = 0
    errors: int = 0
    by_chain: dict[str, int] = field(default_factory=dict)
    total_usd: float = 0.0

    def as_dict(self) -> dict:
        return {
            "wallets": self.wallets,
            "accounts": self.accounts,
            "positions": self.positions,
            "errors": self.errors,
            "by_chain": self.by_chain,
            "total_usd": round(self.total_usd, 2),
        }


def _auth_header() -> str:
    env = load_env()
    key = env.get("ZERION_API_KEY")
    if not key:
        raise RuntimeError("ZERION_API_KEY not set in .env")
    credentials = f"{key}:".encode("ascii")
    return f"Basic {base64.b64encode(credentials).decode('ascii')}"


def get_wallets() -> list[str]:
    """Return the EVM wallet addresses to sync, from the ZERION_WALLETS env var."""
    env = load_env()
    raw = env.get("ZERION_WALLETS", "").strip()
    if not raw:
        return []
    addrs = [a.strip().lower() for a in raw.split(",") if a.strip()]
    return [a for a in addrs if ETH_ADDR_RE.match(a)]


def _fetch_chart(
    address: str,
    period: str = "year",
    chain: str | None = None,
    timeout: float = 30.0,
) -> dict:
    """GET /wallets/{addr}/charts/{period} — historical wallet value.

    Returns {data: {attributes: {points: [[unix_ts, value_usd], ...]}}}.
    Period: hour|day|week|month|year|max. Optional chain filter scopes to
    a single chain id (e.g., 'ethereum', 'base', 'arbitrum').
    """
    qs = ["currency=usd"]
    if chain:
        qs.append(f"filter%5Bchain_ids%5D={chain}")
    url = f"{ZERION_API_BASE}/wallets/{address}/charts/{period}?{'&'.join(qs)}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": _auth_header(),
            "Accept": "application/json",
            "User-Agent": "finance-pipeline/1.0 (+local)",
        },
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(2 ** (attempt + 1))
                continue
            raise
    raise RuntimeError("unreachable")


def _fetch_positions(address: str, timeout: float = 30.0) -> dict:
    """Call Zerion /wallets/{address}/positions.

    Cloudflare rejects urllib's default user-agent with a 1010 error, so
    we spoof a curl-like UA. The request is still authenticated via the
    same Basic header curl uses.
    """
    url = (
        f"{ZERION_API_BASE}/wallets/{address}/positions/"
        "?currency=usd&filter%5Btrash%5D=only_non_trash&page%5Bsize%5D=100"
    )
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": _auth_header(),
            "Accept": "application/json",
            "User-Agent": "finance-pipeline/1.0 (+local)",
        },
    )
    # Retry on 429 (demo tier is 1 req/s; we throttle in the caller but
    # defend in depth here in case callers forget).
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                # Exponential-ish backoff: 2s, 4s, 8s.
                time.sleep(2 ** (attempt + 1))
                continue
            raise
    raise RuntimeError("unreachable")


def _short(addr: str) -> str:
    return f"{addr[:6]}…{addr[-4:]}"


def _upsert_account(
    conn: sqlite3.Connection, account_id: str, display_name: str, institution: str
) -> None:
    conn.execute(
        """
        INSERT INTO accounts (id, display_name, institution, type, currency, active, mode)
        VALUES (?, ?, ?, 'crypto', 'USD', 1, 'live')
        ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name,
            institution = excluded.institution,
            mode = 'live',
            active = 1
        """,
        (account_id, display_name, institution),
    )


def _upsert_holding(
    conn: sqlite3.Connection,
    account_id: str,
    as_of: str,
    symbol: str,
    quantity: float | None,
    value_usd: float,
    *,
    chain: str = "",
    contract_address: str = "",
) -> None:
    """Record a per-token position snapshot. Source 'zerion' for live fetch."""
    positions_mod.upsert_holding(
        conn,
        account_id=account_id,
        symbol=symbol,
        as_of=as_of,
        source="zerion",
        value_usd=value_usd,
        chain=chain,
        contract_address=contract_address,
        quantity=quantity,
        asset_class="crypto",
    )


@dataclass
class ZerionRunResult:
    stats: ZerionStats

    def as_dict(self) -> dict:
        return self.stats.as_dict()


def sync(min_value_usd: float = 1.0, _emit_run_brackets: bool = True) -> ZerionStats:
    """Pull every EVM wallet's positions from Zerion and write to the DB.

    Positions below `min_value_usd` are skipped to avoid polluting the
    dashboard with dust. One account row per (wallet, chain) pair.

    When `_emit_run_brackets=False`, the caller is responsible for emitting
    `sync_started`/`sync_finished` (used by `finance sync all` to wrap the
    whole run in one bracket).
    """
    stats = ZerionStats()
    run_id = uuid.uuid4().hex
    if _emit_run_brackets:
        events.sync_started(run_id=run_id, sources=["zerion"])

    try:
        wallets = get_wallets()
        if not wallets:
            print("no wallets found (set ZERION_WALLETS in .env)")
            if _emit_run_brackets:
                events.sync_finished(
                    run_id=run_id,
                    ok=True,
                    totals={"wallets": 0, "accounts": 0, "errors": 0},
                )
            return stats

        synced_wallets: set[str] = set()

        as_of = datetime.now(timezone.utc).date().isoformat()

        with connect() as conn:
            for i, addr in enumerate(wallets):
                stats.wallets += 1
                if i > 0:
                    # Demo tier limits to 1 req/s. Be polite.
                    time.sleep(1.1)
                try:
                    payload = _fetch_positions(addr)
                except urllib.error.HTTPError as e:
                    stats.errors += 1
                    print(f"  {_short(addr)}  HTTP {e.code}: {e.reason}")
                    events.warning(account_id=None, message=f"{_short(addr)} HTTP {e.code}: {e.reason}")
                    continue
                except Exception as e:
                    stats.errors += 1
                    print(f"  {_short(addr)}  error: {e}")
                    events.warning(account_id=None, message=f"{_short(addr)} error: {e}")
                    continue

                synced_wallets.add(addr.lower())

                positions = payload.get("data", []) or []

                # Group by chain so each (wallet, chain) is its own account row
                by_chain: dict[str, list[dict]] = {}
                for p in positions:
                    attrs = p.get("attributes") or {}
                    # Chain is nested in relationships -> chain -> data -> id
                    rels = p.get("relationships") or {}
                    chain_rel = (rels.get("chain") or {}).get("data") or {}
                    chain = chain_rel.get("id") or "unknown"
                    by_chain.setdefault(chain, []).append(p)

                for chain, chain_positions in by_chain.items():
                    # First pass: collect which positions pass our min-value
                    # filter. We only create the account row if at least one
                    # position survives — otherwise chains Zerion tracks but
                    # where we hold nothing (Monad, Degen, etc.) pollute the
                    # dashboard with $0.00 rows.
                    kept: list[tuple[str, float | None, float, str]] = []
                    for p in chain_positions:
                        attrs = p.get("attributes") or {}
                        fung = attrs.get("fungible_info") or {}
                        symbol = (fung.get("symbol") or "").strip()
                        qty_info = attrs.get("quantity") or {}
                        qty = qty_info.get("float")
                        value = attrs.get("value")
                        if value is None or value < min_value_usd or not symbol:
                            continue
                        # Extract on-chain contract for THIS chain so positions
                        # can disambiguate USDC.e (Avalanche bridge) from native
                        # USDC, etc. Native asset = '' contract.
                        contract = ""
                        for impl in fung.get("implementations") or []:
                            if (impl.get("chain_id") or "") == chain:
                                contract = (impl.get("address") or "").lower()
                                break
                        kept.append((symbol, qty, value, contract))

                    if not kept:
                        continue

                    account_id = f"zerion:{chain}:{addr}"
                    events.account_started(account_id=account_id, source="zerion")
                    try:
                        _upsert_account(
                            conn,
                            account_id,
                            f"{chain.title()} {_short(addr)}",
                            chain.title(),
                        )
                        chain_total = 0.0
                        kept_symbols: set[tuple[str, str]] = set()
                        for symbol, qty, value, contract in kept:
                            _upsert_holding(
                                conn, account_id, as_of, symbol, qty, value,
                                chain=chain, contract_address=contract,
                            )
                            kept_symbols.add((symbol, contract))
                            chain_total += value
                            stats.positions += 1

                        # Zero out positions on this account that PREVIOUSLY had
                        # value but didn't appear in today's fetch — Zerion is
                        # the live source-of-truth for this wallet, so absence
                        # = the user no longer holds it. Without this, stale
                        # backfill:txn-walk snapshots keep showing $99k of USDC
                        # the user already sent away.
                        for prev in conn.execute(
                            """
                            SELECT p.symbol, p.contract_address, p.id
                            FROM positions p
                            WHERE p.account_id = ?
                            """,
                            (account_id,),
                        ).fetchall():
                            if (prev[0], prev[1]) in kept_symbols:
                                continue
                            positions_mod.record_snapshot(
                                conn,
                                position_id=prev[2],
                                as_of=as_of,
                                source="zerion",
                                value_usd=0.0,
                                quantity=0.0,
                            )

                        ledger.assert_balance(
                            conn, account_id, as_of, chain_total, source="zerion"
                        )
                        stats.accounts += 1
                        stats.by_chain[chain] = stats.by_chain.get(chain, 0) + len(kept)
                        stats.total_usd += chain_total
                        print(
                            f"  {_short(addr)}  {chain:12}  "
                            f"{len(kept)} positions  ${chain_total:,.2f}"
                        )
                        events.account_log(
                            account_id=account_id,
                            message=f"wrote {len(kept)} position(s)",
                        )
                        events.account_finished(account_id=account_id, ok=True)
                    except Exception as exc:
                        events.warning(account_id=account_id, message=f"chain {chain}: {exc}")
                        events.account_finished(account_id=account_id, ok=False)
                        raise

        # Backfill historical balance points from Zerion charts API. One
        # request per (wallet, chain) we have positions in. Drops daily
        # balances rows for the past year so the holdings-history chart in
        # the dashboard shows real history instead of a single dot. Idempotent
        # via UPSERT on (account_id, as_of, source).
        print()
        print("backfilling historical wallet values from Zerion charts...")
        chart_points_written = 0
        chain_account_pairs: list[tuple[str, str, str]] = []  # (account_id, addr, chain)
        with connect() as conn:
            for row in conn.execute(
                "SELECT id, institution FROM accounts WHERE id LIKE 'zerion:%' AND active = 1"
            ).fetchall():
                account_id = row["id"]
                # account_id format is `zerion:<chain>:<addr>`
                parts = account_id.split(":", 2)
                if len(parts) == 3:
                    chain_account_pairs.append((account_id, parts[2], parts[1]))

        last_call = 0.0
        for account_id, addr, chain in chain_account_pairs:
            subject = f"{addr.lower()}:{chain}"
            if _cache_hit("zerion:chart", subject, hours=24):
                print(f"  {_short(addr)}  {chain:12}  cached (skip)")
                continue
            # Throttle: 1 req/s on demo tier; extra margin to survive bursts.
            elapsed = time.time() - last_call
            if elapsed < 2.0:
                time.sleep(2.0 - elapsed)
            last_call = time.time()
            try:
                payload = _fetch_chart(addr, period="year", chain=chain)
            except Exception as e:
                print(f"  {_short(addr)}  chart {chain}: error {e}")
                continue
            points = (payload.get("data") or {}).get("attributes", {}).get("points", [])
            if not points:
                continue
            with connect() as conn:
                for ts, value in points:
                    if value is None:
                        continue
                    date_str = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
                    ledger.assert_balance(
                        conn, account_id, date_str, value, source="zerion-chart"
                    )
                    chart_points_written += 1
                _cache_mark(conn, "zerion:chart", subject)
            print(f"  {_short(addr)}  {chain:12}  +{len(points)} historical points")
        print(f"  total chart points stored: {chart_points_written}")

        # Archive manual crypto accounts whose display_name has EVM markers
        # (e.g. address fragments, ENS, common wallet provider names) — Zerion
        # is the live source for those, so manual entries are redundant.
        name_archived = reconcile_evm_by_name()
        if name_archived:
            print(f"reconcile: archived {name_archived} manual crypto accounts (name-matched EVM)")

        # Final pass: drop any remaining manual account with no value.
        zero_archived = clear_zero_value_manual()
        if zero_archived:
            print(f"reconcile: archived {zero_archived} stale manual accounts with no value")

        if _emit_run_brackets:
            events.sync_finished(
                run_id=run_id,
                ok=stats.errors == 0,
                totals={
                    "wallets": stats.wallets,
                    "accounts": stats.accounts,
                    "errors": stats.errors,
                },
            )
        return stats
    except Exception:
        if _emit_run_brackets:
            events.sync_finished(
                run_id=run_id,
                ok=False,
                totals={
                    "wallets": stats.wallets,
                    "accounts": stats.accounts,
                    "errors": stats.errors,
                },
            )
        raise


def reconcile_evm_by_name() -> int:
    """Archive manual crypto accounts whose display_name screams EVM.

    Zerion is the live source for everything EVM, so any manual entry whose
    name references an EVM wallet is redundant.
    """
    EVM_PATTERNS = [
        "%0x%",                  # any account name mentioning an address fragment
        "%.eth%",                 # ENS names
        "%MetaMask%",
        "%Polygon Wallet%",
        "%Arbitrum%Wallet%",
        "%Base **%",
    ]
    archived = 0
    seen_ids: set[str] = set()
    with connect() as conn:
        for pattern in EVM_PATTERNS:
            rows = conn.execute(
                """
                SELECT id FROM accounts
                WHERE type = 'crypto' AND mode = 'manual' AND active = 1
                  AND display_name LIKE ?
                """,
                (pattern,),
            ).fetchall()
            for row in rows:
                if row["id"] in seen_ids:
                    continue
                seen_ids.add(row["id"])
                conn.execute(
                    "UPDATE accounts SET active = 0 WHERE id = ?", (row["id"],)
                )
                archived += 1
    return archived


def clear_zero_value_manual() -> int:
    """Archive any manual account whose most recent v2 balance
    assertion is missing or under $1. Only touches mode='manual' so
    live syncs are never affected."""
    with connect() as conn:
        cur = conn.execute(
            """
            UPDATE accounts SET active = 0
            WHERE mode = 'manual'
              AND active = 1
              AND id IN (
                SELECT a.id
                FROM accounts a
                LEFT JOIN (
                  SELECT account_id, expected_usd,
                         ROW_NUMBER() OVER (
                           PARTITION BY account_id ORDER BY as_of DESC
                         ) AS rn
                  FROM balance_assertions
                ) ba ON ba.account_id = a.id AND ba.rn = 1
                WHERE a.mode = 'manual' AND a.active = 1
                  AND (ba.expected_usd IS NULL OR ABS(ba.expected_usd) < 1.0)
              )
            """
        )
        return cur.rowcount or 0


def print_report(stats: ZerionStats) -> None:
    print(
        f"\nwallets {stats.wallets}  accounts {stats.accounts}  "
        f"positions {stats.positions}  errors {stats.errors}  "
        f"total ${stats.total_usd:,.2f}"
    )
    if stats.by_chain:
        print("\nby chain:")
        for chain, n in sorted(
            stats.by_chain.items(), key=lambda x: -x[1]
        ):
            print(f"  {chain:16}  {n}")
