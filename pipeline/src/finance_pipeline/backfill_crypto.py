"""Backfill historical daily per-symbol holdings for crypto wallets via
Zerion's `/fungibles/{id}/charts/year` endpoint.

Same shape as `backfill_prices.py` but for crypto:
  - Re-fetch current positions per wallet to get fungible IDs (not stored).
  - For each unique fungible, pull daily prices for the past year.
  - Multiply today's quantity × historical price → per-day per-symbol rows.

Assumes current quantities held constant across the window — this misses
swaps, deposits, and yield. The total `balances` series from Zerion's
wallet chart endpoint (already persisted by `zerion.sync`) remains the
source of truth for total value; this backfill only fills in the
per-symbol breakdown for stacked-bar charts.
"""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from . import db, positions as positions_mod
from .env import load_env
from .http import fetch_json

ZERION_API_BASE = "https://api.zerion.io/v1"
# Demo tier is 1 req/s. Backfill runs immediately after zerion.sync() so
# we're already close to quota when we start — be extra conservative.
RATE_LIMIT_DELAY_SEC = 2.0


@dataclass
class CryptoBackfillStats:
    wallets_refetched: int = 0
    fungibles_fetched: int = 0
    fungibles_failed: list[str] = field(default_factory=list)
    holdings_rows: int = 0
    accounts_touched: int = 0

    def as_dict(self) -> dict[str, object]:
        return {
            "wallets_refetched": self.wallets_refetched,
            "fungibles_fetched": self.fungibles_fetched,
            "fungibles_failed": self.fungibles_failed,
            "holdings_rows": self.holdings_rows,
            "accounts_touched": self.accounts_touched,
        }


def _auth_header() -> str:
    env = load_env()
    key = env.get("ZERION_API_KEY")
    if not key:
        raise RuntimeError("ZERION_API_KEY not set in .env")
    return f"Basic {base64.b64encode(f'{key}:'.encode()).decode()}"


def _fetch_json(url: str, timeout: float = 30.0) -> dict | None:
    # Zerion demo tier is 1 req/s but throttles aggressively after a
    # burst — use a longer backoff than the shared helper's default
    # (3s, 6s, 12s, 24s, 48s).
    return fetch_json(
        url,
        headers={"Authorization": _auth_header()},
        timeout=timeout,
        retries=5,
        base_backoff=3.0,
    )


def _fetch_positions(address: str) -> dict | None:
    url = (
        f"{ZERION_API_BASE}/wallets/{address}/positions/"
        "?currency=usd&filter%5Btrash%5D=only_non_trash&page%5Bsize%5D=100"
    )
    return _fetch_json(url)


def _fetch_fungible_chart(fungible_id: str) -> list[tuple[int, float]] | None:
    url = f"{ZERION_API_BASE}/fungibles/{fungible_id}/charts/year?currency=usd"
    body = _fetch_json(url)
    if not body:
        return None
    points = (
        body.get("data", {}).get("attributes", {}).get("points") or []
    )
    out: list[tuple[int, float]] = []
    for p in points:
        if isinstance(p, list) and len(p) >= 2:
            try:
                out.append((int(p[0]), float(p[1])))
            except (TypeError, ValueError):
                continue
    return out or None


def _forward_fill_daily(
    points: list[tuple[int, float]], start: date, end: date
) -> dict[str, float]:
    """Convert sparse (unix_ts, price) points into a dense {YYYY-MM-DD: price}
    map. Zerion's year chart is daily but may skip weekends on thin tokens."""
    per_day: dict[str, float] = {}
    for ts, price in points:
        iso = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        per_day[iso] = price
    out: dict[str, float] = {}
    last: float | None = None
    cursor = start
    while cursor <= end:
        iso = cursor.isoformat()
        if iso in per_day:
            last = per_day[iso]
        if last is not None:
            out[iso] = last
        cursor += timedelta(days=1)
    return out


def backfill_crypto(days: int = 365) -> CryptoBackfillStats:
    stats = CryptoBackfillStats()
    today_d = date.today()
    start_d = today_d - timedelta(days=days)
    today_iso = today_d.isoformat()

    with db.connect() as conn:
        conn.execute("DELETE FROM sync_warnings WHERE source = ?", ("backfill:crypto",))
        # Find all active crypto accounts and their wallet addresses.
        rows = conn.execute(
            """
            SELECT id FROM accounts
            WHERE active = 1 AND mode = 'live' AND id LIKE 'zerion:%'
            """
        ).fetchall()
        if not rows:
            return stats

        # Account id format: zerion:<chain>:<addr>. Group by addr.
        addr_to_accounts: dict[str, list[tuple[str, str]]] = {}
        for (acct_id,) in rows:
            parts = acct_id.split(":", 2)
            if len(parts) != 3:
                continue
            _, chain, addr = parts
            addr_to_accounts.setdefault(addr.lower(), []).append(
                (chain, acct_id)
            )

        # Re-fetch positions to get fungible IDs per (chain, symbol, qty).
        # Structure: {(account_id): [(fungible_id, symbol, qty), ...]}
        per_account_positions: dict[str, list[tuple[str, str, float]]] = {}
        unique_fungibles: set[str] = set()

        last_call = 0.0
        for addr, accts in addr_to_accounts.items():
            # Rate limit.
            elapsed = time.time() - last_call
            if elapsed < RATE_LIMIT_DELAY_SEC:
                time.sleep(RATE_LIMIT_DELAY_SEC - elapsed)
            payload = _fetch_positions(addr)
            last_call = time.time()
            stats.wallets_refetched += 1
            if not payload:
                conn.execute(
                    "INSERT INTO sync_warnings (source, kind, subject, message) VALUES (?,?,?,?)",
                    (
                        "backfill:crypto",
                        "wallet_fetch_failed",
                        addr,
                        "Zerion positions request failed (rate limit or network)",
                    ),
                )
                continue
            for p in payload.get("data") or []:
                attrs = p.get("attributes") or {}
                rels = p.get("relationships") or {}
                chain_id = (
                    (rels.get("chain") or {}).get("data") or {}
                ).get("id")
                fung_data = (rels.get("fungible") or {}).get("data") or {}
                fungible_id = fung_data.get("id")
                symbol = ((attrs.get("fungible_info") or {}).get("symbol") or "").strip()
                qty_info = attrs.get("quantity") or {}
                qty = qty_info.get("float")
                value = attrs.get("value")
                if not (chain_id and fungible_id and symbol):
                    continue
                if qty in (None, 0) or value in (None, 0) or value < 1:
                    continue
                account_id = f"zerion:{chain_id}:{addr}"
                per_account_positions.setdefault(account_id, []).append(
                    (fungible_id, symbol, float(qty))
                )
                unique_fungibles.add(fungible_id)

        # Fetch each unique fungible's year chart once; skip any that
        # were pulled within the last 24h (rows already in holdings).
        from .cache import mark_fetched as _cache_mark, was_fetched_within as _cache_hit
        price_cache: dict[str, dict[str, float]] = {}
        skipped_cached = 0
        for fid in sorted(unique_fungibles):
            if _cache_hit("zerion:fungible", fid, hours=24):
                skipped_cached += 1
                continue
            elapsed = time.time() - last_call
            if elapsed < RATE_LIMIT_DELAY_SEC:
                time.sleep(RATE_LIMIT_DELAY_SEC - elapsed)
            points = _fetch_fungible_chart(fid)
            last_call = time.time()
            if not points:
                stats.fungibles_failed.append(fid)
                conn.execute(
                    "INSERT INTO sync_warnings (source, kind, subject, message) VALUES (?,?,?,?)",
                    (
                        "backfill:crypto",
                        "fungible_chart_failed",
                        fid,
                        "Zerion fungible chart request failed (rate limit or unknown fungible)",
                    ),
                )
                continue
            price_cache[fid] = _forward_fill_daily(points, start_d, today_d)
            stats.fungibles_fetched += 1
            _cache_mark(conn, "zerion:fungible", fid)
        if skipped_cached:
            print(f"  {skipped_cached} fungibles skipped (cache fresh)")

        # Write per-account per-day per-symbol position snapshots.
        for acct_id, positions in per_account_positions.items():
            if not any(fid in price_cache for fid, _, _ in positions):
                continue
            stats.accounts_touched += 1
            # On each date for this account, sum by symbol across multiple
            # positions of the same symbol (shouldn't happen on a single
            # chain, but be defensive).
            per_date_symbol: dict[tuple[str, str], tuple[float, float]] = {}
            # (iso, symbol) -> (qty, value)
            for fid, symbol, qty in positions:
                series = price_cache.get(fid)
                if not series:
                    continue
                for iso, px in series.items():
                    if iso == today_iso:
                        continue  # don't overwrite live sync row
                    v = qty * px
                    key = (iso, symbol)
                    prev_qty, prev_val = per_date_symbol.get(key, (0.0, 0.0))
                    per_date_symbol[key] = (prev_qty + qty, prev_val + v)
            chain = ""
            if acct_id.startswith("zerion:"):
                parts = acct_id.split(":", 3)
                if len(parts) == 3:
                    chain = parts[1]
            for (iso, symbol), (qty, value) in per_date_symbol.items():
                # Flagged with backfill source so query-time
                # source-priority ranks it below live observations.
                positions_mod.upsert_holding(
                    conn,
                    account_id=acct_id,
                    symbol=symbol,
                    as_of=iso,
                    source="backfill:zerion-fungible",
                    value_usd=value,
                    chain=chain,
                    quantity=qty,
                    asset_class="crypto",
                )
                stats.holdings_rows += 1
        conn.commit()
    return stats


def print_report(stats: CryptoBackfillStats) -> None:
    print(f"wallets re-fetched:  {stats.wallets_refetched}")
    print(f"fungibles fetched:   {stats.fungibles_fetched}")
    if stats.fungibles_failed:
        print(f"fungibles failed:    {len(stats.fungibles_failed)}")
    print(f"accounts touched:    {stats.accounts_touched}")
    print(f"holdings rows:       {stats.holdings_rows}")
