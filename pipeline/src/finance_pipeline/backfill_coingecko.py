"""CoinGecko historical price backfill.

Fills the `asset_prices` table with daily USD prices from CoinGecko's
free public API, going back as far as the user has held the asset.
Solves the gap left by Zerion's fungible-chart endpoint (only ~1 year
of history) so qty-walk can reconstruct per-symbol values for older
dates.

Symbol → CoinGecko ID resolution:
  1. Fetch /coins/list?include_platform=true once, cache locally.
  2. Match each symbol we care about by:
     a. (chain, contract_address) lookup if we have on-chain identity
        on the position.
     b. Else exact symbol match if unique on the list.
     c. Else hand-curated overrides (CG_OVERRIDES below) for ambiguous
        symbols (BTC: bitcoin not 'binance-peg-btcb').

Rate limit: free tier is documented at 30 req/min. We sleep 2.2s
between calls to leave headroom; users with a Pro key can override.

Idempotent — re-runs hit the same coin+range cache and skip refetches
unless the data is older than 7 days.
"""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from . import db
from .cache import mark_fetched, was_fetched_within
from .env import load_env


CG_API = "https://api.coingecko.com/api/v3"

# Hand-curated overrides for symbols where CoinGecko's symbol matches
# multiple coins ambiguously. Maps SYMBOL → coingecko_id.
CG_OVERRIDES = {
    "ETH": "ethereum",
    "BTC": "bitcoin",
    "USDC": "usd-coin",
    "USDT": "tether",
    "SOL": "solana",
    "ATOM": "cosmos",
    "ICP": "internet-computer",
    "OSMO": "osmosis",
    "JUNO": "juno-network",
    "AVAX": "avalanche-2",
    "OP": "optimism",
    "ARB": "arbitrum",
    "MATIC": "matic-network",
    "DOT": "polkadot",
    "LINK": "chainlink",
    "MANA": "decentraland",
    "TIA": "celestia",
    "MKR": "maker",
    "DAI": "dai",
    "BAT": "basic-attention-token",
    "BCH": "bitcoin-cash",
    "LTC": "litecoin",
    "ZEC": "zcash",
    "ETC": "ethereum-classic",
    "ZRX": "0x",
    "DNT": "district0x",
    "LOOM": "loom-network-new",
    "GNT": "golem",  # Aragon GNT renamed
    "CVC": "civic",
    "SUI": "sui",
    "SEI": "sei-network",
    "PRIME": "echelon-prime",
    "WBTC": "wrapped-bitcoin",
    "WETH": "weth",
    "DEGEN": "degen-base",
    "TOBY": "toby",
    "DOG": "the-doge-nft",
    "VVV": "venice-token",
    "BUILD": "build-2",
    "SPACE": "spacecoin-base",
    # NOTE: add new mappings here as parsers surface unmatched symbols.
}


@dataclass
class CoinGeckoStats:
    symbols_total: int = 0
    symbols_resolved: int = 0
    symbols_unmatched: list[str] = field(default_factory=list)
    prices_written: int = 0
    requests_made: int = 0
    skipped_cached: int = 0


def _api_key() -> str | None:
    """Optional Pro key — bumps rate limit to 500 req/min."""
    return load_env().get("COINGECKO_API_KEY")


def _http_get(url: str, timeout: float = 30.0) -> dict | list | None:
    headers = {"User-Agent": "finance-pipeline/1.0"}
    key = _api_key()
    if key:
        # Demo keys go against api.coingecko.com with x-cg-demo-api-key.
        # Pro keys go against pro-api.coingecko.com with x-cg-pro-api-key.
        # Sending the WRONG header for the host causes CoinGecko to reject
        # with HTTP 400, even if the other header is present. Pick the
        # right header by URL.
        if "pro-api.coingecko.com" in url:
            headers["x-cg-pro-api-key"] = key
        else:
            headers["x-cg-demo-api-key"] = key
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print(f"  rate limited (429), sleeping 60s")
            time.sleep(60)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.loads(r.read().decode())
            except Exception:
                pass
        print(f"  HTTP {e.code} on {url[:80]}")
        return None
    except Exception as e:
        print(f"  error: {e}")
        return None


def _load_coin_list(conn: sqlite3.Connection) -> list[dict]:
    """Cached CoinGecko coin list. Refreshes every 7 days."""
    if was_fetched_within("coingecko:list", "all", hours=24 * 7):
        row = conn.execute(
            "SELECT payload FROM raw_events WHERE source = 'coingecko-list' "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row:
            try:
                return json.loads(row[0])
            except (TypeError, ValueError):
                pass
    print("  fetching CoinGecko coin list…")
    data = _http_get(f"{CG_API}/coins/list?include_platform=true")
    if not isinstance(data, list):
        return []
    conn.execute(
        "INSERT INTO raw_events (source, external_id, payload, source_file) "
        "VALUES (?, ?, ?, ?)",
        ("coingecko-list", f"list-{date.today().isoformat()}",
         json.dumps(data), "coingecko-api"),
    )
    mark_fetched(conn, "coingecko:list", "all")
    conn.commit()
    return data


def _resolve_symbol(
    symbol: str,
    chain: str,
    contract: str,
    coin_list: list[dict],
    chain_alias: dict[str, str],
) -> str | None:
    """Return a CoinGecko coin id for this symbol, or None if unmatched."""
    sym_upper = (symbol or "").upper()
    if not sym_upper:
        return None
    # 1. Hand override.
    if sym_upper in CG_OVERRIDES:
        return CG_OVERRIDES[sym_upper]
    contract_l = (contract or "").lower()
    if chain and contract_l:
        cg_chain = chain_alias.get(chain.lower(), chain.lower())
        for c in coin_list:
            platforms = c.get("platforms") or {}
            if platforms.get(cg_chain) == contract_l:
                return c["id"]
    # 2. Unique symbol match.
    matches = [c for c in coin_list if (c.get("symbol") or "").upper() == sym_upper]
    if len(matches) == 1:
        return matches[0]["id"]
    return None


# Map our chain identifiers to CoinGecko's `platforms` keys.
_CHAIN_ALIAS = {
    "ethereum": "ethereum",
    "base": "base",
    "polygon": "polygon-pos",
    "arbitrum": "arbitrum-one",
    "optimism": "optimistic-ethereum",
    "avalanche": "avalanche",
    "scroll": "scroll",
    "zora": "zora-network",
    "unichain": "unichain",
    "bnb": "binance-smart-chain",
    "celo": "celo",
    "fantom": "fantom",
    "gnosis": "xdai",
}


def _fetch_history(coin_id: str, start_d: date, end_d: date) -> dict[str, float]:
    """Daily prices via /coins/{id}/market_chart?days=N. Demo tier
    caps days at 365 (Pro is required for longer history); we clamp
    accordingly. CoinGecko returns daily granularity automatically when
    days > 90."""
    today = date.today()
    requested_days = (today - start_d).days
    days = min(max(requested_days, 1), 365)
    url = f"{CG_API}/coins/{coin_id}/market_chart?vs_currency=usd&days={days}"
    data = _http_get(url)
    if not isinstance(data, dict):
        return {}
    points = data.get("prices") or []
    out: dict[str, float] = {}
    start_iso = start_d.isoformat()
    end_iso = end_d.isoformat()
    for ts_ms, px in points:
        d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).date().isoformat()
        if d < start_iso or d > end_iso:
            continue
        out[d] = float(px)
    return out


def _symbols_to_backfill(conn: sqlite3.Connection) -> list[tuple[str, str, str, str, str]]:
    """List (symbol, chain, contract, earliest_date, latest_date) tuples
    — every symbol we hold (from positions) plus every CoinTracker txn
    currency, with the date range we'd need prices for."""
    out: list[tuple[str, str, str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    for r in conn.execute(
        """
        SELECT p.symbol, p.chain, p.contract_address,
               MIN(t.date), MAX(t.date)
        FROM positions p
        LEFT JOIN postings post ON post.account_id = p.account_id
        LEFT JOIN transactions_v2 t ON t.id = post.txn_id
        WHERE p.asset_class = 'crypto'
        GROUP BY p.symbol, p.chain, p.contract_address
        """
    ).fetchall():
        sym, chain, contract, mn, mx = r
        if not sym:
            continue
        key = (sym, chain or "", (contract or "").lower())
        if key in seen:
            continue
        seen.add(key)
        out.append((sym, chain or "", contract or "", mn or "", mx or ""))

    return out


def backfill(days_back: int = 365 * 9) -> CoinGeckoStats:
    """Fetch historical prices for every crypto symbol we hold. Default
    range is 9 years (covers CoinTracker history back to 2017)."""
    stats = CoinGeckoStats()
    today_d = date.today()
    floor_d = today_d - timedelta(days=days_back)
    delay = 2.2 if not _api_key() else 0.15

    with db.connect() as conn:
        coin_list = _load_coin_list(conn)
        if not coin_list:
            print("  could not load CoinGecko coin list — aborting")
            return stats

        targets = _symbols_to_backfill(conn)
        # Group by resolved coingecko_id so multi-chain WETH all share
        # one price fetch.
        coin_to_dates: dict[str, tuple[set[str], date, date]] = {}
        coin_to_symbols: defaultdict[str, set[str]] = defaultdict(set)
        for sym, chain, contract, mn, mx in targets:
            stats.symbols_total += 1
            coin_id = _resolve_symbol(sym, chain, contract, coin_list, _CHAIN_ALIAS)
            if not coin_id:
                stats.symbols_unmatched.append(f"{sym} ({chain or 'no-chain'})")
                continue
            stats.symbols_resolved += 1
            try:
                start_d = max(date.fromisoformat(mn), floor_d) if mn else floor_d
            except ValueError:
                start_d = floor_d
            cur = coin_to_dates.get(coin_id)
            if cur is None:
                coin_to_dates[coin_id] = (set(), start_d, today_d)
            else:
                _, prev_start, prev_end = cur
                coin_to_dates[coin_id] = (
                    set(), min(prev_start, start_d), max(prev_end, today_d),
                )
            coin_to_symbols[coin_id].add(sym)

        for coin_id, (_unused, start_d, end_d) in sorted(coin_to_dates.items()):
            cache_key = f"{coin_id}|{start_d.isoformat()}|{end_d.isoformat()}"
            if was_fetched_within("coingecko:price", cache_key, hours=24 * 7):
                stats.skipped_cached += 1
                continue
            time.sleep(delay)
            stats.requests_made += 1
            prices = _fetch_history(coin_id, start_d, end_d)
            if not prices:
                continue
            symbols_for_coin = coin_to_symbols[coin_id]
            for d_iso, px in prices.items():
                for sym in symbols_for_coin:
                    conn.execute(
                        """
                        INSERT INTO asset_prices
                          (symbol, as_of, source, price_usd)
                        VALUES (?, ?, 'coingecko', ?)
                        ON CONFLICT(symbol, as_of, source) DO UPDATE SET
                          price_usd = excluded.price_usd,
                          ingested_at = CURRENT_TIMESTAMP
                        """,
                        (sym, d_iso, px),
                    )
                    stats.prices_written += 1
            mark_fetched(conn, "coingecko:price", cache_key)
            conn.commit()

    return stats


def print_report(stats: CoinGeckoStats) -> None:
    print(f"  symbols total:        {stats.symbols_total}")
    print(f"  resolved to CG ids:   {stats.symbols_resolved}")
    print(f"  prices written:       {stats.prices_written}")
    print(f"  requests made:        {stats.requests_made}")
    print(f"  skipped (cached):     {stats.skipped_cached}")
    if stats.symbols_unmatched:
        print(f"  unmatched (top 15):")
        for s in sorted(stats.symbols_unmatched)[:15]:
            print(f"    {s}")
