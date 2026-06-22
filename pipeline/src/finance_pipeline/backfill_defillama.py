"""DefiLlama historical price backfill.

Why over CoinGecko: DefiLlama's free coins API has no key and no real
rate limit, queries by `chain:contract_address` (matches our
positions.contract_address directly), and serves daily prices back to
~2018 for any token with on-chain liquidity history.

Endpoint: https://coins.llama.fi/chart/{coins}?start={ts}&span={N}&period=1d
  - coins:  comma-separated keys; each key is `coingecko:<id>` for
            major coins or `<chain>:<contract>` for on-chain tokens
  - span:   max 500 data points per request — chunked for full history
  - period: '1d' for daily

Writes to asset_prices with source='defillama'. Position-snapshot
readers already prefer asset_prices over derived holdings prices, so
this just plugs into the existing trust order.
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


LLAMA_API = "https://coins.llama.fi"

# DefiLlama chain identifiers — same names CoinGecko uses for the most
# part, so we can reuse our existing Zerion → CG mapping.
_LLAMA_CHAIN_ALIAS = {
    "ethereum": "ethereum",
    "base": "base",
    "polygon": "polygon",
    "arbitrum": "arbitrum",
    "optimism": "optimism",
    "avalanche": "avax",  # llama uses 'avax'
    "scroll": "scroll",
    "zora": "zora",
    "unichain": "unichain",
    "bnb": "bsc",
    "solana": "solana",
}


# Major coins without on-chain identity in our positions table — we fall
# back to coingecko:<id> keys. Same hand-curated list as the CoinGecko
# backfill since DefiLlama uses CG ids as a coin-identity layer.
_CG_OVERRIDES = {
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
    "MANA": "decentraland",
    "TIA": "celestia",
    "MKR": "maker",
    "DAI": "dai",
    "BCH": "bitcoin-cash",
    "LTC": "litecoin",
    "ZEC": "zcash",
    "ETC": "ethereum-classic",
    "BAT": "basic-attention-token",
    "ZRX": "0x",
    "SUI": "sui",
    "SEI": "sei-network",
    "OP": "optimism",
    "ARB": "arbitrum",
    "DNT": "district0x",
    "LOOM": "loom-network-new",
    "GNT": "golem",
    "CVC": "civic",
    "PRIME": "echelon-prime",
    "WBTC": "wrapped-bitcoin",
    "WETH": "weth",
}


@dataclass
class LlamaStats:
    targets: int = 0
    requests: int = 0
    prices_written: int = 0
    skipped_cached: int = 0
    skipped: list[str] = field(default_factory=list)


def _http_get(url: str, timeout: float = 30.0) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": "finance-pipeline/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:200] if e.fp else ""
        print(f"  HTTP {e.code} on {url[:90]}: {msg[:100]}")
        return None
    except Exception as e:
        print(f"  err on {url[:90]}: {e}")
        return None


def _coin_key(symbol: str, chain: str, contract: str) -> str | None:
    """Build a DefiLlama coin key. Prefer chain:contract for on-chain
    identity (catches USDC.e and other bridged variants); fall back to
    coingecko:<id> for off-chain or wrapped natives."""
    chain_l = chain.lower()
    contract_l = contract.lower()
    if chain_l and contract_l:
        llama_chain = _LLAMA_CHAIN_ALIAS.get(chain_l, chain_l)
        return f"{llama_chain}:{contract_l}"
    sym = (symbol or "").upper()
    cg_id = _CG_OVERRIDES.get(sym)
    if cg_id:
        return f"coingecko:{cg_id}"
    return None


def _fetch_history(coin_key: str, start_d: date) -> dict[str, float]:
    """Daily prices in [start_d, today]. Chains multiple span=500 calls
    forward-walking from start_d until we reach today."""
    out: dict[str, float] = {}
    cursor_ts = int(datetime(start_d.year, start_d.month, start_d.day,
                             tzinfo=timezone.utc).timestamp())
    today_ts = int(datetime.now(timezone.utc).timestamp())
    last_ts = 0
    while cursor_ts < today_ts:
        url = f"{LLAMA_API}/chart/{coin_key}?start={cursor_ts}&span=500&period=1d"
        data = _http_get(url)
        if not data:
            break
        coins = data.get("coins") or {}
        if not coins:
            break
        # Response key may differ from request (DefiLlama normalizes).
        actual_key = next(iter(coins.keys()))
        prices = coins[actual_key].get("prices") or []
        if not prices:
            break
        for p in prices:
            ts = int(p["timestamp"])
            d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
            out[d] = float(p["price"])
            if ts > last_ts:
                last_ts = ts
        # Advance cursor to the day after the latest point we got.
        new_cursor = last_ts + 86400
        if new_cursor <= cursor_ts:
            break  # no progress, bail
        cursor_ts = new_cursor
    return out


def _latest_stored(
    conn: sqlite3.Connection, identities: list[tuple[str, str, str]]
) -> date | None:
    """Most recent as_of across every (chain, contract, symbol) tuple
    this coin_key maps to, considering both defillama and coingecko
    sources (either covers today's price adequately). Returning this as
    start_d makes the next fetch incremental: only days we don't already
    have. None if nothing stored yet."""
    if not identities:
        return None
    clauses = []
    params: list[str] = []
    for sym, chain, contract in identities:
        clauses.append("(chain = ? AND contract_address = ? AND symbol = ?)")
        params.extend([chain, contract, sym])
    row = conn.execute(
        f"""
        SELECT MAX(as_of) AS mx FROM asset_prices
        WHERE source IN ('defillama','coingecko')
          AND ({" OR ".join(clauses)})
        """,
        tuple(params),
    ).fetchone()
    if not row or not row[0]:
        return None
    try:
        return date.fromisoformat(row[0])
    except ValueError:
        return None


def _targets(conn: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
    """List (symbol, chain, contract, earliest_date) tuples for every
    crypto position we hold. Earliest date comes from the first
    posting on that account (= when the user first acquired any of
    that wallet's tokens) so we don't fetch history older than needed."""
    out: list[tuple[str, str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for r in conn.execute(
        """
        SELECT p.symbol, p.chain, p.contract_address,
               MIN(t.date)
        FROM positions p
        LEFT JOIN postings post ON post.account_id = p.account_id
        LEFT JOIN transactions_v2 t ON t.id = post.txn_id
        WHERE p.asset_class = 'crypto'
        GROUP BY p.symbol, p.chain, p.contract_address
        """
    ).fetchall():
        sym, chain, contract, mn = r
        if not sym:
            continue
        key = (sym, chain or "", (contract or "").lower())
        if key in seen:
            continue
        seen.add(key)
        out.append((sym, chain or "", contract or "", mn or "2017-01-01"))
    return out


def backfill(min_date: str = "2017-01-01", incremental: bool = True) -> LlamaStats:
    """Fetch DefiLlama daily prices into asset_prices.

    ``incremental`` (default True) checks each coin's latest stored
    as_of and starts the next fetch from there — a post-sync run that
    already has everything through yesterday fetches just today, one
    request per coin. Pass False to ignore stored state (rare: only
    when backfilling history from scratch).
    """
    stats = LlamaStats()
    floor_d = date.fromisoformat(min_date)
    today_d = datetime.now(tz=timezone.utc).date()
    with db.connect() as conn:
        targets = _targets(conn)
        # De-dup by coin_key so we don't fetch the same coin twice
        # (e.g. WETH on multiple chains all map to coingecko:weth).
        # Each coin_key keeps the full list of (sym, chain, contract)
        # identities it covers so we write per-identity rows that
        # satisfy the (chain, contract, symbol, as_of, source) PK.
        by_key: dict[str, dict] = {}
        for sym, chain, contract, earliest in targets:
            stats.targets += 1
            ck = _coin_key(sym, chain, contract)
            if not ck:
                stats.skipped.append(f"{sym} ({chain or 'no-chain'})")
                continue
            try:
                start_d = max(date.fromisoformat(earliest), floor_d)
            except ValueError:
                start_d = floor_d
            ident = (sym, chain, contract)
            cur = by_key.get(ck)
            if cur is None:
                by_key[ck] = {"identities": [ident], "start_d": start_d}
            else:
                if ident not in cur["identities"]:
                    cur["identities"].append(ident)
                cur["start_d"] = min(cur["start_d"], start_d)

        for ck, entry in sorted(by_key.items()):
            identities: list[tuple[str, str, str]] = entry["identities"]
            start_d: date = entry["start_d"]
            if incremental:
                latest = _latest_stored(conn, identities)
                if latest is not None and latest >= today_d:
                    # Already have today — nothing to do. Skip the HTTP call.
                    stats.skipped_cached += 1
                    continue
                if latest is not None:
                    start_d = max(start_d, latest + timedelta(days=1))

            prices = _fetch_history(ck, start_d)
            stats.requests += 1
            if not prices:
                continue
            for d_iso, px in prices.items():
                for sym, chain, contract in identities:
                    conn.execute(
                        """
                        INSERT INTO asset_prices
                          (chain, contract_address, symbol, as_of, source, price_usd)
                        VALUES (?, ?, ?, ?, 'defillama', ?)
                        ON CONFLICT(chain, contract_address, symbol, as_of, source)
                        DO UPDATE SET
                          price_usd = excluded.price_usd,
                          ingested_at = CURRENT_TIMESTAMP
                        """,
                        (chain, contract, sym, d_iso, px),
                    )
                    stats.prices_written += 1
            conn.commit()
            syms_summary = sorted({s for s, _, _ in identities})
            print(
                f"  {ck:<60}  {len(prices)} pts → {syms_summary}"
            )
    return stats


def print_report(stats: LlamaStats) -> None:
    print(f"  targets:        {stats.targets}")
    print(f"  requests:       {stats.requests}")
    print(f"  skipped (fresh):{stats.skipped_cached}")
    print(f"  prices written: {stats.prices_written}")
    if stats.skipped:
        print(f"  unmatched (no chain+contract and no CG override):")
        for s in sorted(stats.skipped)[:15]:
            print(f"    {s}")
