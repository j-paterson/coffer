"""Backfill per-symbol historical position values via CoinTracker txn walk.

For accounts where we have CoinTracker transaction history (raw_events
with source='cointracker'), reconstruct quantity-over-time per
(canonical_account, symbol) by walking deltas chronologically. Then
multiply by historical USD price (from existing Zerion fungible chart
backfill cached in `holdings`) to get a per-day per-symbol value series,
written to `position_snapshots` with source='backfill:txn-walk'.

This is the architecturally correct approach for crypto wallets the
user actively trades on: it captures the actual quantity trajectory
(buys, sells, transfers) instead of assuming current-quantity-was-
constant. For HODL-only wallets the existing backfill_crypto.py
(qty × historical price, source='backfill:zerion-fungible') is
adequate.

Source priority makes both safe to coexist:
  zerion-chart > zerion > alchemy > kubera > simplefin > backfill:txn-walk > backfill:zerion-fungible

Live observations always win; among backfills, the txn-walk one wins
because it reflects real quantity changes. (Add to HOLDINGS_TRUST_ORDER
and the SQL CASE in accounts_v2 / portfolio_v2 / etc.)
"""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime

from . import db, positions as positions_mod


@dataclass
class QtyWalkStats:
    accounts_walked: int = 0
    symbols_processed: int = 0
    snapshots_written: int = 0
    skipped_no_price: list[str] = field(default_factory=list)


def _parse_iso(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s.split(" ", 1)[0], "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


def _f(x: object) -> float:
    if x is None:
        return 0.0
    s = str(x).strip().replace(",", "")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _walk_account_symbol_quantities(
    conn: sqlite3.Connection,
    account_id: str,
    wallet_to_canonical: dict[str, str],
) -> dict[str, list[tuple[str, float]]]:
    """For one canonical account, return {symbol: [(date, quantity_after), …]}.

    Reads CoinTracker raw_events directly (not postings) so intra-wallet
    TRADE rows — which the posting layer skips because they don't affect
    USD value — still apply to per-symbol quantity. A trade USDC→ETH on
    Coinbase decreases USDC qty AND increases ETH qty even though the
    wallet's USD total is unchanged.

    `wallet_to_canonical` maps CoinTracker's wallet-name strings to our
    canonical account ids (built once for the whole walk)."""
    rows = conn.execute(
        """
        SELECT payload FROM raw_events WHERE source = 'cointracker'
        ORDER BY id
        """
    ).fetchall()
    by_symbol: defaultdict[str, defaultdict[str, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    for (payload_json,) in rows:
        try:
            row = json.loads(payload_json)
        except (TypeError, ValueError):
            continue
        date_iso = _parse_iso(row.get("Date") or "")
        if not date_iso:
            continue
        # Sent side reduces source wallet's quantity of Sent Currency.
        sent_wallet = wallet_to_canonical.get(
            (row.get("Sent Wallet") or "").strip().lower()
        )
        if sent_wallet == account_id:
            sym = (row.get("Sent Currency") or "").strip()
            qty = _f(row.get("Sent Quantity"))
            if sym and qty:
                by_symbol[sym][date_iso] -= qty
        # Received side increases dest wallet's quantity of Received Currency.
        recv_wallet = wallet_to_canonical.get(
            (row.get("Received Wallet") or "").strip().lower()
        )
        if recv_wallet == account_id:
            sym = (row.get("Received Currency") or "").strip()
            qty = _f(row.get("Received Quantity"))
            if sym and qty:
                by_symbol[sym][date_iso] += qty

    # Convert per-day deltas into running quantity series.
    out: dict[str, list[tuple[str, float]]] = {}
    for sym, daily in by_symbol.items():
        sorted_dates = sorted(daily.keys())
        running = 0.0
        series: list[tuple[str, float]] = []
        for d in sorted_dates:
            running += daily[d]
            series.append((d, running))
        out[sym] = series
    return out


def _price_series_for_symbol(
    conn: sqlite3.Connection,
    canonical_account_id: str,
    symbol: str,
) -> dict[str, float]:
    """Per-day USD price for this symbol. Two sources merged with
    asset_prices winning by source-priority where both have a value:

      asset_prices       — explicit prices written by CoinGecko/yfinance
                           backfills (symbol-keyed, multi-year history)
      position_snapshots — implicit prices = value_usd / quantity from
                           Zerion's fungible-chart backfill (~1 year)

    asset_prices.coingecko has the longest history; position_snapshots
    fills in where asset_prices has gaps. Either way price > 0 wins."""
    out: dict[str, float] = {}
    # Implicit price first (lower priority — overwritten below).
    for r in conn.execute(
        """
        SELECT ps.as_of, AVG(ps.value_usd / ps.quantity) AS price
        FROM position_snapshots ps
        JOIN positions p ON p.id = ps.position_id
        WHERE p.symbol = ?
          AND ps.quantity IS NOT NULL AND ps.quantity > 0
          AND ps.value_usd > 0
        GROUP BY ps.as_of
        """,
        (symbol,),
    ).fetchall():
        if r[1] is not None and r[1] > 0:
            out[r[0]] = r[1]
    # Explicit prices from asset_prices win (and extend further back).
    # defillama goes back furthest (~2018+); coingecko caps at 365d on
    # Demo tier; yfinance is the equity-only fallback.
    for r in conn.execute(
        """
        SELECT as_of, price_usd, source FROM asset_prices
        WHERE symbol = ? AND price_usd > 0
        ORDER BY as_of, CASE source
          WHEN 'defillama'         THEN 0
          WHEN 'coingecko'         THEN 1
          WHEN 'backfill:yfinance' THEN 2
          ELSE 3
        END
        """,
        (symbol,),
    ).fetchall():
        out[r[0]] = r[1]
    return out


def _build_wallet_to_canonical(conn: sqlite3.Connection) -> dict[str, str]:
    """Map every CoinTracker wallet-name string (and address) to its
    canonical account id. Reuses cointracker_v2._map_wallet so the rules
    stay aligned with the ingest path; then resolves alias→canonical."""
    from .parsers import cointracker_v2

    address_index = cointracker_v2._build_address_index(conn)
    canonical_of = dict(
        conn.execute(
            "SELECT id, COALESCE(merged_into, id) FROM accounts"
        ).fetchall()
    )

    out: dict[str, str] = {}
    seen: set[tuple[str, str]] = set()
    for (payload_json,) in conn.execute(
        "SELECT payload FROM raw_events WHERE source = 'cointracker'"
    ).fetchall():
        try:
            row = json.loads(payload_json)
        except (TypeError, ValueError):
            continue
        for wkey, akey in (
            ("Sent Wallet", "Sent Address"),
            ("Received Wallet", "Received Address"),
        ):
            wallet = (row.get(wkey) or "").strip()
            addr = (row.get(akey) or "").strip()
            if not wallet and not addr:
                continue
            key = (wallet.lower(), addr.lower())
            if key in seen:
                continue
            seen.add(key)
            from dataclasses import dataclass as _dc
            stub = cointracker_v2.CointrackerStats()
            mapped = cointracker_v2._map_wallet(
                wallet, addr, address_index, stub
            )
            canonical = canonical_of.get(mapped, mapped)
            out[wallet.lower()] = canonical
    return out


def run() -> QtyWalkStats:
    stats = QtyWalkStats()
    with db.connect() as conn:
        wallet_to_canonical = _build_wallet_to_canonical(conn)
        canon_rows = conn.execute(
            """
            SELECT DISTINCT COALESCE(a.merged_into, a.id) AS canonical
            FROM accounts a
            JOIN postings p ON p.account_id = a.id
            JOIN event_links el ON el.txn_id = p.txn_id
            JOIN raw_events re ON re.id = el.raw_id
            WHERE re.source = 'cointracker'
              AND COALESCE(a.merged_into, a.id) NOT LIKE 'equity:%'
            """
        ).fetchall()

        for (canonical,) in canon_rows:
            stats.accounts_walked += 1
            chain = ""
            if canonical.startswith("zerion:"):
                parts = canonical.split(":", 3)
                if len(parts) == 3:
                    chain = parts[1]
            qty_series = _walk_account_symbol_quantities(
                conn, canonical, wallet_to_canonical
            )
            for symbol, series in qty_series.items():
                price_by_date = _price_series_for_symbol(conn, canonical, symbol)
                if not price_by_date:
                    stats.skipped_no_price.append(f"{canonical[:30]} / {symbol}")
                    continue
                stats.symbols_processed += 1
                # Build a daily snapshot only on dates we have BOTH a
                # quantity (forward-filled from the latest delta) AND a
                # price. Forward-fill quantity: between deltas, hold flat.
                # Cap snapshot emission at the LAST CoinTracker txn date for
                # this (account, symbol). After that we don't actually know
                # whether the user still holds it — the tokens could have
                # been sent on-chain without CoinTracker knowing. Forward-
                # filling a stale qty for a year (then suddenly cliff-dropping
                # when Zerion's zero-snapshot lands) is a worse lie than
                # simply not having data past the last known activity.
                qty_iter = sorted(series, key=lambda x: x[0])
                if not qty_iter:
                    continue
                last_delta_date = qty_iter[-1][0]
                series_dates = sorted(
                    d for d in ({d for d, _ in series} | price_by_date.keys())
                    if d <= last_delta_date
                )
                cursor_qty = 0.0
                qty_idx = 0
                for d in series_dates:
                    while qty_idx < len(qty_iter) and qty_iter[qty_idx][0] <= d:
                        cursor_qty = qty_iter[qty_idx][1]
                        qty_idx += 1
                    if cursor_qty <= 0:
                        continue
                    price = price_by_date.get(d)
                    if price is None or price <= 0:
                        continue
                    value_usd = cursor_qty * price
                    positions_mod.upsert_holding(
                        conn,
                        account_id=canonical,
                        symbol=symbol,
                        as_of=d,
                        source="backfill:txn-walk",
                        value_usd=value_usd,
                        chain=chain,
                        quantity=cursor_qty,
                        asset_class="crypto",
                    )
                    stats.snapshots_written += 1
        conn.commit()
    return stats


def print_report(stats: QtyWalkStats) -> None:
    print(f"  accounts walked:      {stats.accounts_walked}")
    print(f"  symbols processed:    {stats.symbols_processed}")
    print(f"  snapshots written:    {stats.snapshots_written}")
    if stats.skipped_no_price:
        print(f"  skipped (no price): {len(stats.skipped_no_price)}")
        for s in stats.skipped_no_price[:5]:
            print(f"    {s}")
