"""On-chain historical balance reconstruction via Alchemy getAssetTransfers.

For every active EVM wallet (zerion:<chain>:<addr>), pull the full
ERC-20 transfer history (in + out) from Alchemy, walk it
chronologically per (chain, contract) accumulating quantity, then
multiply by daily DefiLlama price → position_snapshots with
source='alchemy-history'.

Architecturally this beats CoinTracker for individual wallets:
  - Truth comes from the chain itself, no third-party sync to keep current
  - Captures every wallet you've ever interacted with (no allowlist)
  - Picks up sends/receives CT missed (private wallets, complex defi)

Trust order: alchemy-history sits above backfill:txn-walk so where both
reconstruct a (wallet, symbol, date), Alchemy wins. Live observations
(zerion / simplefin) still beat both.

Method: alchemy_getAssetTransfers with category=['erc20','external']
(external = native ETH transfers). Paginated via pageKey. Retries on
HTTP 429 / 500. Native ETH balance derived as
∑(received_external) − ∑(sent_external) plus gas paid (best-effort —
gas is only known if the user is the from_address; we read receipts
for that).
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

from . import db, positions as positions_mod
from .env import load_env
from .ledger import record_event


# Reuse the chain slug map from the existing alchemy parser.
_CHAINS = {
    "ethereum": "eth-mainnet",
    "base":     "base-mainnet",
    "polygon":  "polygon-mainnet",
    "optimism": "opt-mainnet",
    "arbitrum": "arb-mainnet",
}

# Native asset symbol per chain (for `external` transfers).
_NATIVE_SYMBOL = {
    "ethereum": "ETH",
    "base":     "ETH",
    "polygon":  "MATIC",
    "optimism": "ETH",
    "arbitrum": "ETH",
}


@dataclass
class AlchemyHistoryStats:
    wallets: int = 0
    transfers_pulled: int = 0
    positions_touched: int = 0
    snapshots_written: int = 0
    skipped_no_price: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _api_key() -> str:
    env = load_env()
    key = env.get("ALCHEMY_API_KEY")
    if not key:
        raise RuntimeError("ALCHEMY_API_KEY missing in .env")
    return key


def _rpc(chain: str, method: str, params: list[object]) -> object:
    slug = _CHAINS[chain]
    url = f"https://{slug}.g.alchemy.com/v2/{_api_key()}"
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload = json.loads(r.read())
                if "error" in payload:
                    raise RuntimeError(
                        f"alchemy {method} error: {payload['error']}"
                    )
                return payload.get("result")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise


def _fetch_transfers(chain: str, address: str) -> list[dict]:
    """Pull every transfer in OR out for `address`, ERC-20 + native."""
    out: list[dict] = []
    for direction in ("toAddress", "fromAddress"):
        page_key: str | None = None
        while True:
            # `internal` (native ETH routed via contract calls — DEX
            # swaps, bridges, LP withdrawals) is only supported by
            # Alchemy on Ethereum mainnet and Polygon. Requesting it on
            # L2s returns -32602 and the whole page errors out, so
            # omit the category on chains that don't support it.
            categories = ["erc20", "external"]
            if chain in ("ethereum", "polygon"):
                categories.append("internal")
            params = [{
                direction: address,
                "category": categories,
                "withMetadata": True,
                "maxCount": "0x3e8",  # 1000 per page (max)
                "order": "asc",
            }]
            if page_key:
                params[0]["pageKey"] = page_key
            try:
                result = _rpc(chain, "alchemy_getAssetTransfers", params)
            except Exception as e:
                print(f"  err {chain} {address[:10]}: {e}")
                break
            if not result:
                break
            transfers = result.get("transfers") or []
            for t in transfers:
                t["_direction"] = direction
            out.extend(transfers)
            page_key = result.get("pageKey")
            if not page_key:
                break
            time.sleep(0.05)  # small breather between pages
    return out


def _walk_quantities(
    transfers: list[dict],
    chain: str,
    own_address: str,
) -> dict[str, list[tuple[str, float, str]]]:
    """Return {contract_address: [(date, qty_after, symbol), …]}.
    Native asset uses contract='' and symbol from _NATIVE_SYMBOL[chain].
    qty_after is the running balance after each transfer."""
    own = own_address.lower()
    by_asset: defaultdict[str, list[tuple[str, float, str]]] = defaultdict(list)
    running: defaultdict[str, float] = defaultdict(float)

    # Sort transfers by blockTimestamp ascending across both directions.
    def ts_of(t: dict) -> str:
        meta = t.get("metadata") or {}
        return meta.get("blockTimestamp") or ""
    transfers.sort(key=ts_of)

    for t in transfers:
        meta = t.get("metadata") or {}
        ts_iso = meta.get("blockTimestamp") or ""
        if not ts_iso:
            continue
        d = ts_iso[:10]
        # Direction
        from_addr = (t.get("from") or "").lower()
        to_addr = (t.get("to") or "").lower()
        sign = 0
        if to_addr == own:
            sign = +1
        if from_addr == own:
            sign -= 1
        if sign == 0:
            continue  # neither side is our wallet (shouldn't happen)
        category = t.get("category") or ""
        symbol = (t.get("asset") or "").strip().upper()
        contract = ""
        raw_contract = t.get("rawContract") or {}
        if category == "erc20":
            contract = (raw_contract.get("address") or "").lower()
        else:
            # native external
            symbol = _NATIVE_SYMBOL.get(chain, symbol)
        # Quantity from `value` field — already decimal-adjusted by Alchemy.
        try:
            qty = float(t.get("value") or 0)
        except (TypeError, ValueError):
            continue
        if qty <= 0:
            continue
        running[contract] += sign * qty
        by_asset[contract].append((d, running[contract], symbol))
    return dict(by_asset)


def _price_series(
    conn: sqlite3.Connection, chain: str, contract: str, symbol: str,
) -> dict[str, float]:
    """Daily USD price for a position identified by (chain, contract).

    Matches strictly on (chain, contract_address). Scam tokens at fake
    contracts with spoofed symbols will simply not resolve — they
    shouldn't; that's the whole point. `symbol` is informational only
    (carried for debugging / logging)."""
    rows = conn.execute(
        """
        SELECT as_of, price_usd FROM asset_prices
        WHERE chain = ? AND contract_address = ? AND price_usd > 0
        ORDER BY as_of, CASE source
          WHEN 'defillama'         THEN 0
          WHEN 'coingecko'         THEN 1
          WHEN 'geckoterminal'     THEN 2
          WHEN 'backfill:yfinance' THEN 3
          ELSE 4
        END
        """,
        (chain, contract),
    ).fetchall()
    out: dict[str, float] = {}
    for r in rows:
        out.setdefault(r[0], r[1])
    return out


def _process_wallet(
    conn: sqlite3.Connection,
    acct_id: str,
    chain: str,
    addr: str,
    transfers: list[dict],
    stats: AlchemyHistoryStats,
) -> None:
    """Walk transfers → snapshots for one (chain, address). Pure consumer
    of `transfers`; doesn't care whether they came from a live RPC fetch
    or a raw_events replay."""
    if not transfers:
        return
    qty_by_contract = _walk_quantities(transfers, chain, addr)
    for contract, series in qty_by_contract.items():
        # Pick a representative symbol (most-common in series).
        symbols = [s for _, _, s in series]
        if not symbols:
            continue
        symbol = max(set(symbols), key=symbols.count)
        price_by_date = _price_series(conn, chain, contract, symbol)
        if not price_by_date:
            label = f"{acct_id} / {symbol} ({contract[:10] or 'native'})"
            stats.skipped_no_price.append(label)
            continue
        stats.positions_touched += 1
        # Cap forward-fill at last delta date for this position.
        last_delta_date = series[-1][0]
        series_dates = sorted(
            d for d in (
                {d for d, _, _ in series} | price_by_date.keys()
            )
            if d <= last_delta_date
        )
        qty_iter = sorted(series, key=lambda x: x[0])
        cursor_qty = 0.0
        qty_idx = 0
        for d in series_dates:
            while qty_idx < len(qty_iter) and qty_iter[qty_idx][0] <= d:
                cursor_qty = qty_iter[qty_idx][1]
                qty_idx += 1
            if cursor_qty <= 0:
                # Quantity went to 0 — write a zero-snapshot
                # (truthful: we know the user no longer holds it)
                positions_mod.upsert_holding(
                    conn,
                    account_id=acct_id,
                    symbol=symbol,
                    as_of=d,
                    source="alchemy-history",
                    value_usd=0.0,
                    chain=chain,
                    contract_address=contract,
                    quantity=0.0,
                    asset_class="crypto",
                )
                stats.snapshots_written += 1
                continue
            price = price_by_date.get(d)
            if price is None or price <= 0:
                continue
            positions_mod.upsert_holding(
                conn,
                account_id=acct_id,
                symbol=symbol,
                as_of=d,
                source="alchemy-history",
                value_usd=cursor_qty * price,
                chain=chain,
                contract_address=contract,
                quantity=cursor_qty,
                asset_class="crypto",
            )
            stats.snapshots_written += 1


def backfill() -> AlchemyHistoryStats:
    stats = AlchemyHistoryStats()
    with db.connect() as conn:
        wallets = conn.execute(
            """
            SELECT id FROM accounts
            WHERE active = 1 AND id LIKE 'zerion:%'
            """
        ).fetchall()
        for (acct_id,) in wallets:
            parts = acct_id.split(":", 2)
            if len(parts) != 3:
                continue
            _, chain, addr = parts
            if chain not in _CHAINS:
                continue
            stats.wallets += 1
            print(f"  {acct_id[:55]}")
            try:
                transfers = _fetch_transfers(chain, addr)
            except Exception as e:
                stats.errors.append(f"{acct_id}: {e}")
                continue
            stats.transfers_pulled += len(transfers)
            # Cache each Alchemy transfer before processing so we can
            # replay the quantity-walk + pricing offline.
            for t in transfers:
                tx_hash = t.get("hash") or ""
                tx_idx = t.get("uniqueId") or t.get("logIndex") or ""
                if not tx_hash:
                    continue
                record_event(
                    conn,
                    source="alchemy-history",
                    external_id=f"alchemy-transfer:{chain}:{addr.lower()}:{tx_hash}:{tx_idx}:{t.get('_direction','')}",
                    payload=t,
                )
            _process_wallet(conn, acct_id, chain, addr, transfers, stats)
            conn.commit()
    return stats


def replay() -> AlchemyHistoryStats:
    """Reprocess cached Alchemy transfers from raw_events without hitting
    the API. Reads every alchemy-history transfer payload, regroups by
    (chain, address) parsed from the external_id, and re-runs the
    qty-walk + pricing → position_snapshots.

    Use after a price-source change, a price backfill, or a positions/
    snapshot-writing logic change to refresh derived snapshots without
    burning Alchemy compute units."""
    stats = AlchemyHistoryStats()
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT external_id, payload FROM raw_events
            WHERE source = 'alchemy-history'
              AND external_id LIKE 'alchemy-transfer:%'
            """
        ).fetchall()
        # external_id shape: alchemy-transfer:{chain}:{addr}:{tx_hash}:{tx_idx}:{direction}
        by_wallet: dict[tuple[str, str], list[dict]] = {}
        for ext_id, payload_json in rows:
            parts = ext_id.split(":", 5)
            if len(parts) < 6:
                continue
            _, chain, addr, _hash, _idx, _dir = parts
            try:
                t = json.loads(payload_json)
            except (TypeError, ValueError):
                continue
            by_wallet.setdefault((chain, addr), []).append(t)

        # Look up the canonical account_id for each (chain, addr). Wallets
        # that no longer have an active account row are skipped — same
        # rule the live backfill enforces.
        acct_by_wallet: dict[tuple[str, str], str] = {}
        for (chain, addr) in by_wallet:
            row = conn.execute(
                """
                SELECT id FROM accounts
                WHERE active = 1 AND id = ?
                """,
                (f"zerion:{chain}:{addr}",),
            ).fetchone()
            if row:
                acct_by_wallet[(chain, addr)] = row[0]

        for (chain, addr), transfers in by_wallet.items():
            acct_id = acct_by_wallet.get((chain, addr))
            if not acct_id:
                continue
            if chain not in _CHAINS:
                continue
            stats.wallets += 1
            stats.transfers_pulled += len(transfers)
            print(f"  {acct_id[:55]}  (replay, {len(transfers)} cached)")
            _process_wallet(conn, acct_id, chain, addr, transfers, stats)
            conn.commit()
    return stats


def print_report(stats: AlchemyHistoryStats) -> None:
    print(f"  wallets:            {stats.wallets}")
    print(f"  transfers pulled:   {stats.transfers_pulled}")
    print(f"  positions touched:  {stats.positions_touched}")
    print(f"  snapshots written:  {stats.snapshots_written}")
    if stats.skipped_no_price:
        print(f"  skipped (no price): {len(stats.skipped_no_price)}")
        for s in stats.skipped_no_price[:10]:
            print(f"    {s}")
    if stats.errors:
        print(f"  errors: {len(stats.errors)}")
        for s in stats.errors[:5]:
            print(f"    {s}")
