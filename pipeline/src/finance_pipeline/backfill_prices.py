"""Backfill historical daily balances for investment accounts using
Yahoo Finance's public chart endpoint.

Strategy: for each active brokerage/retirement account with per-symbol
holdings, take the *current* quantity as constant across the window and
multiply by each symbol's daily close price. This ignores past
contributions and rebalances — the shape captures market movement but
not cash flows into/out of the account.

The per-account endpoint in the dashboard already walks transactions to
model contribution/withdrawal cash flow; the two sources are written
with different `source` values and the API layer can overlay them:

  - 'simplefin'          — live snapshots (source of truth, never overwrite)
  - 'backfill:yfinance'  — synthesized historical from price × qty
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from . import db, ledger, positions as positions_mod
from .http import fetch_json

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
COINGECKO_CHART_URL = (
    "https://api.coingecko.com/api/v3/coins/{id}/market_chart"
    "?vs_currency=usd&days={days}"
)

# Be gentle — Yahoo throttles aggressive anonymous polling.
PRICE_REQUEST_DELAY_SEC = 0.6
# CoinGecko free tier allows ~30 req/min, so ~2s between calls is safe.
COINGECKO_DELAY_SEC = 2.2

# Symbol → CoinGecko coin-id. Covers every asset we've seen on the
# user's Coinbase account; additions can be dropped in here as needed.
_COINGECKO_IDS: dict[str, str] = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "LTC": "litecoin",
    "BCH": "bitcoin-cash",
    "ETC": "ethereum-classic",
    "USDC": "usd-coin",
    "USDT": "tether",
    "SOL": "solana",
    "AVAX": "avalanche-2",
    "ATOM": "cosmos",
    "SUI": "sui",
    "ICP": "internet-computer",
    "OP": "optimism",
    "SEI": "sei-network",
    "TIA": "celestia",
    "MKR": "maker",
    "ZEC": "zcash",
    "MANA": "decentraland",
    "BAT": "basic-attention-token",
    "ZRX": "0x",
    "CVC": "civic",
    "DNT": "district0x",
    "GNT": "golem",
    "LOOM": "loom-network",
    "METIS": "metis-token",
    "PRIME": "echelon-prime",
    "MATIC": "matic-network",
}


@dataclass
class BackfillStats:
    accounts: int = 0
    symbols_fetched: int = 0
    symbols_failed: list[str] = field(default_factory=list)
    balance_rows: int = 0

    def as_dict(self) -> dict[str, object]:
        return {
            "accounts": self.accounts,
            "symbols_fetched": self.symbols_fetched,
            "symbols_failed": self.symbols_failed,
            "balance_rows": self.balance_rows,
        }


def _fetch_daily_closes(
    symbol: str, days: int
) -> dict[str, float] | None:
    """Return {YYYY-MM-DD: close} for `symbol` over the past `days` days.
    Returns None on any failure; caller should warn and continue.
    """
    now = int(datetime.now(tz=timezone.utc).timestamp())
    start = now - (days + 5) * 86400  # pad a few days to handle weekends
    url = YAHOO_CHART_URL.format(symbol=symbol) + f"?period1={start}&period2={now}&interval=1d"
    body = fetch_json(url)
    if not body:
        return None
    result = body.get("chart", {}).get("result") or []
    if not result:
        return None
    r = result[0]
    timestamps = r.get("timestamp") or []
    indicators = r.get("indicators", {}).get("quote") or []
    if not indicators:
        return None
    closes = indicators[0].get("close") or []
    out: dict[str, float] = {}
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        out[d] = float(c)
    return out or None


def _fetch_coingecko_daily(
    symbol: str, days: int
) -> dict[str, float] | None:
    """Return {YYYY-MM-DD: close_price_usd} for `symbol` from CoinGecko.
    Returns None if the symbol is unmapped or the fetch fails."""
    coin_id = _COINGECKO_IDS.get(symbol.upper())
    if not coin_id:
        return None
    body = fetch_json(COINGECKO_CHART_URL.format(id=coin_id, days=days))
    if not body:
        return None
    # CoinGecko returns {"prices": [[ts_ms, usd], ...]} at hourly-or-daily
    # granularity. For days>1 they return daily (one per UTC midnight).
    out: dict[str, float] = {}
    for ts_ms, price in body.get("prices") or []:
        if price is None:
            continue
        d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).date().isoformat()
        # A given date may appear twice (boundary); keep the last value.
        out[d] = float(price)
    return out or None


def _forward_fill(
    closes: dict[str, float], start: date, end: date
) -> dict[str, float]:
    """Fill weekends/holidays by carrying the last known close forward."""
    out: dict[str, float] = {}
    last: float | None = None
    cursor = start
    while cursor <= end:
        iso = cursor.isoformat()
        if iso in closes:
            last = closes[iso]
        if last is not None:
            out[iso] = last
        cursor = cursor + timedelta(days=1)
    return out


def _reset_warnings(conn, source: str) -> None:
    conn.execute("DELETE FROM sync_warnings WHERE source = ?", (source,))


def _record_warning(conn, source: str, kind: str, subject: str, msg: str = "") -> None:
    conn.execute(
        "INSERT INTO sync_warnings (source, kind, subject, message) VALUES (?,?,?,?)",
        (source, kind, subject, msg or None),
    )


def backfill_investments(days: int = 365) -> BackfillStats:
    """Write synthesized daily balance rows for every investment account
    that has per-symbol holdings in the latest snapshot."""
    stats = BackfillStats()
    with db.connect() as conn:
        _reset_warnings(conn, "backfill:prices")
        # Accounts eligible for price-based backfill: live, active,
        # brokerage/retirement, with at least one non-zero v2 position.
        accts = conn.execute(
            """
            SELECT DISTINCT a.id, a.display_name
            FROM accounts a
            JOIN positions p ON p.account_id = a.id
            JOIN position_snapshots ps ON ps.position_id = p.id
            WHERE a.active = 1 AND a.mode = 'live'
              AND a.type IN ('brokerage','retirement')
              AND ps.value_usd > 0
            """
        ).fetchall()
        if not accts:
            return stats

        # Load latest per-symbol holdings per account from v2 snapshots.
        holdings_by_acct: dict[str, list[tuple[str, float]]] = {}
        all_symbols: set[str] = set()
        for acct_id, _name in accts:
            rows = conn.execute(
                """
                SELECT p.symbol, ps.quantity
                FROM positions p
                JOIN position_snapshots ps ON ps.position_id = p.id
                WHERE p.account_id = ?
                  AND ps.quantity IS NOT NULL AND ps.quantity > 0
                  AND ps.as_of = (
                    SELECT MAX(as_of) FROM position_snapshots
                    WHERE position_id = p.id
                  )
                """,
                (acct_id,),
            ).fetchall()
            if not rows:
                continue
            picked: list[tuple[str, float]] = []
            for sym, qty in rows:
                sym = (sym or "").strip().upper()
                if not sym or sym == "UNKNOWN":
                    continue
                picked.append((sym, float(qty)))
                all_symbols.add(sym)
            if picked:
                holdings_by_acct[acct_id] = picked

        # Fetch price history for each unique symbol once.
        price_cache: dict[str, dict[str, float]] = {}
        today_d = date.today()
        start_d = today_d - timedelta(days=days)
        for sym in sorted(all_symbols):
            closes = _fetch_daily_closes(sym, days)
            if not closes:
                stats.symbols_failed.append(sym)
                _record_warning(
                    conn,
                    "backfill:prices",
                    "symbol_not_found",
                    sym,
                    f"Yahoo Finance returned no price history for {sym}",
                )
                continue
            price_cache[sym] = _forward_fill(closes, start_d, today_d)
            stats.symbols_fetched += 1
            time.sleep(PRICE_REQUEST_DELAY_SEC)

        # Compose daily account values and write to balances + holdings.
        # Writing per-symbol holdings rows lights up the stacked-bars chart
        # on the dashboard (which reads holdings per as_of date).
        today_iso = date.today().isoformat()
        for acct_id, picks in holdings_by_acct.items():
            if not any(sym in price_cache for sym, _ in picks):
                continue
            # Per-(date, symbol) values.
            per_symbol_daily: dict[tuple[str, str], float] = {}
            daily_total: dict[str, float] = {}
            for sym, qty in picks:
                series = price_cache.get(sym)
                if not series:
                    continue
                for iso, px in series.items():
                    v = qty * px
                    per_symbol_daily[(iso, sym)] = v
                    daily_total[iso] = daily_total.get(iso, 0.0) + v

            if not daily_total:
                continue
            stats.accounts += 1
            for iso, total in daily_total.items():
                ledger.assert_balance(
                    conn,
                    account_id=acct_id,
                    as_of=iso,
                    expected_usd=total,
                    source="backfill:yfinance",
                )
                stats.balance_rows += 1
            # Per-symbol snapshots, skipping today so we don't overwrite
            # the live simplefin-sourced row with a synthesized one.
            for (iso, sym), v in per_symbol_daily.items():
                if iso == today_iso:
                    continue
                qty = next((q for s, q in picks if s == sym), None)
                positions_mod.upsert_holding(
                    conn,
                    account_id=acct_id,
                    symbol=sym,
                    as_of=iso,
                    source="backfill:yfinance",
                    value_usd=v,
                    quantity=qty,
                )
        conn.commit()
    return stats


def print_report(stats: BackfillStats) -> None:
    print(f"accounts backfilled: {stats.accounts}")
    print(f"symbols fetched:     {stats.symbols_fetched}")
    if stats.symbols_failed:
        print(f"symbols failed:      {', '.join(stats.symbols_failed)}")
    print(f"balance rows written: {stats.balance_rows}")
