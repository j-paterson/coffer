"""Coinbase Advanced Trade API: direct historical reconstruction.

For each Coinbase per-asset wallet (BTC Wallet, ETH Wallet, USDC Wallet,
etc.) pull every transaction since account inception, walk chronologically
to derive quantity over time, multiply by daily DefiLlama / CoinGecko
price → position_snapshots with source='coinbase-direct'.

Beats SimpleFIN for Coinbase coverage:
  - No 5-year SimpleFIN cap; reaches back to user's first Coinbase txn
  - Direct from source — no aggregator delay
  - Per-asset wallet detail matches our existing simplefin:ACT-* accounts

Account mapping:
  Coinbase UUID + display name → existing simplefin:ACT-* canonical
  by case-insensitive name match (e.g., "ETH Wallet" → the simplefin
  Coinbase ETH Wallet account). Unmatched accounts fall through to
  coinbase:exchange-bundle.

Auth: requires .secrets/coinbase_trading_key.json with `name` (UUID
form `organizations/{org}/apiKeys/{key}`) + `privateKey` (PEM EC).
"""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from .. import db, positions as positions_mod
from ..ledger import record_event


KEY_PATH = Path(__file__).resolve().parents[4] / ".secrets" / "coinbase_trading_key.json"
COINBASE_BUNDLE = "coinbase:exchange-bundle"


@dataclass
class CoinbaseDirectStats:
    accounts_visible: int = 0
    accounts_mapped: int = 0
    txns_pulled: int = 0
    snapshots_written: int = 0
    skipped_no_price: list[str] = field(default_factory=list)
    unmapped: list[str] = field(default_factory=list)


def _client():
    from coinbase.rest import RESTClient
    if not KEY_PATH.exists():
        raise RuntimeError(
            f"Coinbase trading key not found at {KEY_PATH}. "
            "Generate one at portal.cdp.coinbase.com/access/api as ECDSA, "
            "save the JSON there with chmod 600."
        )
    with KEY_PATH.open() as f:
        k = json.load(f)
    return RESTClient(api_key=k["name"], api_secret=k["privateKey"])


def _attr(obj: object, name: str, default: object = None) -> object:
    """Coinbase SDK returns weird mixed dataclass/dict objects."""
    if hasattr(obj, name):
        return getattr(obj, name)
    if isinstance(obj, dict):
        return obj.get(name, default)
    return default


def _all_accounts(client) -> list:
    out: list = []
    cursor: str | None = None
    while True:
        res = client.get_accounts(limit=250, cursor=cursor)
        accts = _attr(res, "accounts", [])
        out.extend(accts)
        cursor = _attr(res, "cursor")
        if not _attr(res, "has_next"):
            break
    return out


def _build_account_map(
    conn: sqlite3.Connection, cb_accounts: list
) -> dict[str, str]:
    """Coinbase account UUID → our canonical account_id.

    Strategy: case-insensitive name match against the simplefin Coinbase
    sub-accounts that already exist (e.g., "ETH Wallet" → simplefin:ACT-...
    whose display_name contains "ETH Wallet"). Fall through to
    COINBASE_BUNDLE for unmatched ones."""
    sf_rows = conn.execute(
        """
        SELECT id, display_name FROM accounts
        WHERE id LIKE 'simplefin:%' AND institution = 'Coinbase'
        """,
    ).fetchall()
    sf_by_norm: dict[str, str] = {}
    for acct_id, disp in sf_rows:
        # Normalize: strip the trailing UUID parenthetical and lower.
        n = (disp or "").lower().split(" (")[0].strip()
        sf_by_norm[n] = acct_id

    out: dict[str, str] = {}
    for cb in cb_accounts:
        cb_uuid = _attr(cb, "uuid")
        cb_name = (_attr(cb, "name") or "").lower().strip()
        if cb_name in sf_by_norm:
            out[cb_uuid] = sf_by_norm[cb_name]
        else:
            out[cb_uuid] = COINBASE_BUNDLE
    return out


def _v2_get(path: str, key_name: str, key_secret: str) -> dict | None:
    """Authed GET against api.coinbase.com/v2 using the same ECDSA JWT
    auth as Advanced Trade. The Python SDK only wraps Advanced Trade
    paths, so we hand-roll v2 calls — the JWT works for both."""
    from coinbase import jwt_generator
    # JWT URI format: METHOD host path (no query string, no scheme).
    base_uri = path.split("?", 1)[0]
    uri = jwt_generator.format_jwt_uri("GET", base_uri)
    token = jwt_generator.build_rest_jwt(uri, key_name, key_secret)
    req = urllib.request.Request(
        f"https://api.coinbase.com{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "CB-VERSION": "2024-01-01",
            "User-Agent": "finance-pipeline/1.0",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            print(f"    v2 HTTP {e.code} on {path[:60]}")
            return None
        except Exception as e:
            print(f"    v2 err on {path[:60]}: {e}")
            return None


def _v2_list_accounts(key_name: str, key_secret: str) -> list[dict]:
    """v2 account list — paginated, returns name + uuid."""
    out: list[dict] = []
    next_uri: str | None = "/v2/accounts?limit=100"
    while next_uri:
        res = _v2_get(next_uri, key_name, key_secret)
        if not res:
            break
        out.extend(res.get("data") or [])
        pagination = res.get("pagination") or {}
        next_uri = pagination.get("next_uri")
    return out


def _all_transactions(account_uuid: str, key_name: str, key_secret: str) -> list:
    """v2 transactions for one Coinbase account, paginated newest-first."""
    out: list = []
    next_uri: str | None = (
        f"/v2/accounts/{account_uuid}/transactions?limit=100"
    )
    while next_uri:
        res = _v2_get(next_uri, key_name, key_secret)
        if not res:
            break
        out.extend(res.get("data") or [])
        next_uri = (res.get("pagination") or {}).get("next_uri")
    return out


def _price_series(conn: sqlite3.Connection, symbol: str) -> dict[str, float]:
    """Daily USD price for a Coinbase wallet's currency.

    Coinbase's wallet nomenclature is symbol-only ("ETH Wallet", "USDC
    Wallet", "LINK Wallet") — unambiguous within Coinbase, but maps to
    a canonical token that may sit at a specific (chain, contract) in
    our asset_prices table. This lookup matches by symbol across any
    (chain, contract) and picks the highest-trust source. Safe here
    because Coinbase doesn't list scam look-alikes under a reused
    ticker; within Coinbase "USDC" means canonical USDC, etc."""
    out: dict[str, float] = {}
    for r in conn.execute(
        """
        SELECT as_of, price_usd FROM asset_prices
        WHERE symbol = ? AND price_usd > 0
        ORDER BY as_of, CASE source
          WHEN 'defillama'     THEN 0
          WHEN 'coingecko'     THEN 1
          WHEN 'geckoterminal' THEN 2
          WHEN 'backfill:yfinance' THEN 3
          ELSE 4
        END
        """,
        (symbol,),
    ).fetchall():
        out.setdefault(r[0], r[1])
    return out


def _walk_account(
    conn: sqlite3.Connection,
    canonical: str,
    cb_name: str,
    currency: str,
    qty_today: float,
    txns: list[dict],
    today_iso: str,
    stats: CoinbaseDirectStats,
) -> None:
    """Walk this account's v2 txn history → position_snapshots. Pure
    consumer of `txns`; works the same whether they came from the live
    API or a raw_events replay. Also writes today's balance snapshot
    when qty_today is set."""

    # Today's snapshot — current Coinbase truth.
    price_today = None
    if currency == "USD":
        price_today = 1.0
    else:
        ps = _price_series(conn, currency)
        # Most-recent price ≤ today
        if ps:
            price_today = ps.get(today_iso) or ps.get(sorted(ps.keys())[-1])
    if price_today is not None and qty_today > 0:
        positions_mod.upsert_holding(
            conn,
            account_id=canonical,
            symbol=currency,
            as_of=today_iso,
            source="coinbase-direct",
            value_usd=qty_today * price_today,
            quantity=qty_today,
            asset_class="crypto" if currency != "USD" else "cash",
        )
        stats.snapshots_written += 1

    if not txns:
        return

    # v2 txn shape: {created_at, type, amount: {amount, currency},
    #                status, ...}. amount is signed (negative on
    #                outflows). Status filter to completed only.
    deltas_by_date: defaultdict[str, float] = defaultdict(float)
    for t in txns:
        if (t.get("status") or "") != "completed":
            continue
        created = (t.get("created_at") or "").strip()
        if not created:
            continue
        d = created[:10]
        amt = (t.get("amount") or {}).get("amount")
        if amt is None:
            continue
        try:
            deltas_by_date[d] += float(amt)
        except ValueError:
            continue
    if not deltas_by_date:
        return

    # Walk chronologically, build running balance per date.
    sorted_dates = sorted(deltas_by_date.keys())
    running = 0.0
    qty_by_date: dict[str, float] = {}
    for d in sorted_dates:
        running += deltas_by_date[d]
        qty_by_date[d] = running

    # Multiply by daily price (or 1.0 for USD) and write snapshots.
    if currency == "USD":
        price_by_date = {d: 1.0 for d in qty_by_date}
    else:
        price_by_date = _price_series(conn, currency)
        if not price_by_date:
            stats.skipped_no_price.append(f"{cb_name} ({currency})")
            return

    # Cap forward-fill at last delta date for this asset (same
    # honesty as backfill:txn-walk).
    last_delta = sorted_dates[-1]
    walk_dates = sorted(
        set(qty_by_date.keys()) | (
            set(price_by_date.keys()) if currency != "USD" else set()
        )
    )
    walk_dates = [d for d in walk_dates if d <= last_delta]
    cursor_qty = 0.0
    qty_iter = sorted(qty_by_date.items())
    qty_idx = 0
    for d in walk_dates:
        while qty_idx < len(qty_iter) and qty_iter[qty_idx][0] <= d:
            cursor_qty = qty_iter[qty_idx][1]
            qty_idx += 1
        if cursor_qty <= 0:
            # Explicit zero — we know the user no longer holds it.
            positions_mod.upsert_holding(
                conn,
                account_id=canonical,
                symbol=currency,
                as_of=d,
                source="coinbase-direct",
                value_usd=0.0,
                quantity=0.0,
                asset_class="crypto" if currency != "USD" else "cash",
            )
            stats.snapshots_written += 1
            continue
        p = price_by_date.get(d) or 1.0 if currency == "USD" else price_by_date.get(d)
        # If DefiLlama has a price gap on exactly this date but
        # the qty changed (i.e., this IS a transaction date),
        # still write the snapshot — fall back to the nearest
        # neighbor price so forward-fill in the downstream
        # breakdown picks up the qty shift. Without this a
        # single-day price gap on the disposition date leaves
        # the chart forward-filling the previous qty for months.
        if (p is None or p <= 0) and d in qty_by_date:
            neighbors = [
                (abs((date.fromisoformat(pd) - date.fromisoformat(d)).days), px)
                for pd, px in price_by_date.items()
                if px and px > 0
            ]
            if neighbors:
                neighbors.sort()
                p = neighbors[0][1]
        if p is None or p <= 0:
            continue
        positions_mod.upsert_holding(
            conn,
            account_id=canonical,
            symbol=currency,
            as_of=d,
            source="coinbase-direct",
            value_usd=cursor_qty * p,
            quantity=cursor_qty,
            asset_class="crypto" if currency != "USD" else "cash",
        )
        stats.snapshots_written += 1


def sync() -> CoinbaseDirectStats:
    stats = CoinbaseDirectStats()
    # Read key once, use both Advanced Trade SDK + raw v2 calls.
    with KEY_PATH.open() as f:
        kdata = json.load(f)
    key_name = kdata["name"]
    key_secret = kdata["privateKey"]

    client = _client()
    cb_accts = _all_accounts(client)
    stats.accounts_visible = len(cb_accts)

    # v2 accounts give us the v2 UUIDs, which can differ from Advanced
    # Trade UUIDs and are the keys for /v2/accounts/{id}/transactions.
    v2_accts = _v2_list_accounts(key_name, key_secret)
    v2_uuid_by_name: dict[str, str] = {}
    for v2 in v2_accts:
        v2_uuid_by_name[(v2.get("name") or "").lower().strip()] = v2.get("id")

    today_iso = datetime.now(timezone.utc).date().isoformat()

    with db.connect() as conn:
        uuid_to_canonical = _build_account_map(conn, cb_accts)
        # Cache the v2 account list so wallet ↔ uuid mapping is
        # reproducible offline.
        today_stamp = datetime.now(timezone.utc).date().isoformat()
        for v2 in v2_accts:
            v2id = v2.get("id") or ""
            if not v2id:
                continue
            record_event(
                conn,
                source="coinbase-direct",
                external_id=f"coinbase-v2-account:{v2id}:{today_stamp}",
                payload=v2,
            )
        for cb in cb_accts:
            cb_uuid = _attr(cb, "uuid")
            cb_name = _attr(cb, "name") or ""
            currency = _attr(cb, "currency") or ""
            bal = _attr(cb, "available_balance", {})
            qty_str = _attr(bal, "value", "0")
            try:
                qty = float(qty_str)
            except (TypeError, ValueError):
                qty = 0.0

            canonical = uuid_to_canonical[cb_uuid]
            if canonical == COINBASE_BUNDLE:
                stats.unmapped.append(f"{cb_name} → bundle")
            else:
                stats.accounts_mapped += 1

            # Cache the Advanced Trade account snapshot (balance + metadata
            # as of today) so we can replay "today's snapshot" offline.
            record_event(
                conn,
                source="coinbase-direct",
                external_id=f"coinbase-v3-account:{cb_uuid}:{today_stamp}",
                payload=cb if isinstance(cb, dict) else dict(cb.__dict__),
            )

            # Pull v2 historical transactions for this account.
            v2_uuid = v2_uuid_by_name.get(cb_name.lower().strip())
            if not v2_uuid:
                # Account not in v2 list (rare — usually staking/derivatives);
                # still write today's snapshot before bailing.
                _walk_account(
                    conn, canonical, cb_name, currency, qty, [],
                    today_iso, stats,
                )
                continue
            txns = _all_transactions(v2_uuid, key_name, key_secret)
            stats.txns_pulled += len(txns)
            # Cache raw v2 txn payloads before processing — lets us replay
            # downstream logic without re-hitting the Coinbase API.
            for t in txns:
                tid = t.get("id") or ""
                if not tid:
                    continue
                record_event(
                    conn,
                    source="coinbase-direct",
                    external_id=f"coinbase-v2-txn:{v2_uuid}:{tid}",
                    payload=t,
                )
            _walk_account(
                conn, canonical, cb_name, currency, qty, txns,
                today_iso, stats,
            )
            conn.commit()
    return stats


def replay() -> CoinbaseDirectStats:
    """Reprocess cached Coinbase account + txn payloads from raw_events
    without hitting the API. Reads the most-recent v2 + v3 account
    snapshots and every cached v2 txn, then re-runs the qty-walk +
    pricing → position_snapshots.

    Use after a price-source change, a price backfill, or a positions/
    snapshot-writing logic change to refresh derived snapshots without
    burning Coinbase API budget."""
    stats = CoinbaseDirectStats()
    today_iso = datetime.now(timezone.utc).date().isoformat()

    with db.connect() as conn:
        # Latest v3 (Advanced Trade) account snapshot per cb_uuid.
        v3_rows = conn.execute(
            """
            WITH ranked AS (
              SELECT external_id, payload,
                ROW_NUMBER() OVER (
                  PARTITION BY substr(external_id, 1, length(external_id) - 11)
                  ORDER BY external_id DESC
                ) AS rn
              FROM raw_events
              WHERE source = 'coinbase-direct'
                AND external_id LIKE 'coinbase-v3-account:%'
            )
            SELECT external_id, payload FROM ranked WHERE rn = 1
            """
        ).fetchall()
        cb_accts: list[dict] = []
        for ext_id, payload_json in v3_rows:
            try:
                cb_accts.append(json.loads(payload_json))
            except (TypeError, ValueError):
                continue
        stats.accounts_visible = len(cb_accts)

        # Latest v2 account snapshot per v2id.
        v2_rows = conn.execute(
            """
            WITH ranked AS (
              SELECT external_id, payload,
                ROW_NUMBER() OVER (
                  PARTITION BY substr(external_id, 1, length(external_id) - 11)
                  ORDER BY external_id DESC
                ) AS rn
              FROM raw_events
              WHERE source = 'coinbase-direct'
                AND external_id LIKE 'coinbase-v2-account:%'
            )
            SELECT payload FROM ranked WHERE rn = 1
            """
        ).fetchall()
        v2_uuid_by_name: dict[str, str] = {}
        for (payload_json,) in v2_rows:
            try:
                v2 = json.loads(payload_json)
            except (TypeError, ValueError):
                continue
            v2_uuid_by_name[(v2.get("name") or "").lower().strip()] = v2.get("id")

        # All cached v2 txns, grouped by v2_uuid (parsed from external_id).
        txn_rows = conn.execute(
            """
            SELECT external_id, payload FROM raw_events
            WHERE source = 'coinbase-direct'
              AND external_id LIKE 'coinbase-v2-txn:%'
            """
        ).fetchall()
        txns_by_v2: dict[str, list[dict]] = {}
        for ext_id, payload_json in txn_rows:
            parts = ext_id.split(":", 2)
            if len(parts) < 3:
                continue
            # parts: ["coinbase-v2-txn", "{v2_uuid}", "{tid}"]
            v2_uuid = parts[1]
            try:
                t = json.loads(payload_json)
            except (TypeError, ValueError):
                continue
            txns_by_v2.setdefault(v2_uuid, []).append(t)
            stats.txns_pulled += 1

        uuid_to_canonical = _build_account_map(conn, cb_accts)

        for cb in cb_accts:
            cb_uuid = _attr(cb, "uuid")
            cb_name = _attr(cb, "name") or ""
            currency = _attr(cb, "currency") or ""
            bal = _attr(cb, "available_balance", {})
            qty_str = _attr(bal, "value", "0")
            try:
                qty = float(qty_str)
            except (TypeError, ValueError):
                qty = 0.0

            canonical = uuid_to_canonical.get(cb_uuid, COINBASE_BUNDLE)
            if canonical == COINBASE_BUNDLE:
                stats.unmapped.append(f"{cb_name} → bundle")
            else:
                stats.accounts_mapped += 1

            v2_uuid = v2_uuid_by_name.get(cb_name.lower().strip())
            txns = txns_by_v2.get(v2_uuid or "", [])
            _walk_account(
                conn, canonical, cb_name, currency, qty, txns,
                today_iso, stats,
            )
            conn.commit()
    return stats


def print_report(stats: CoinbaseDirectStats) -> None:
    print(f"  accounts visible:    {stats.accounts_visible}")
    print(f"  accounts mapped:     {stats.accounts_mapped}")
    print(f"  txns pulled:         {stats.txns_pulled}")
    print(f"  snapshots written:   {stats.snapshots_written}")
    if stats.unmapped:
        print(f"  unmapped → bundle ({len(stats.unmapped)}):")
        for s in stats.unmapped[:10]:
            print(f"    {s}")
    if stats.skipped_no_price:
        print(f"  skipped (no price): {len(stats.skipped_no_price)}")
        for s in stats.skipped_no_price[:5]:
            print(f"    {s}")
