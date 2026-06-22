"""Alchemy-based crypto wallet sync.

Mirrors `parsers.zerion.sync()` for current wallet state, but uses
Alchemy JSON-RPC (token balances + native balance) and CoinGecko
(historical + current USD prices) instead. Written as a drop-in backup
for when Zerion's demo-tier rate limiter misbehaves.

Emits the same ``zerion:<chain>:<addr>`` account IDs so the dashboard's
wallet-grouping UI stays coherent regardless of which provider last
wrote. Balance rows use ``source='alchemy'`` so they don't clobber
Zerion rows — the networth endpoint's source-priority already prefers
live provider rows over synthesized backfill.

Not yet implemented: `alchemy_getAssetTransfers` historical reconstruction,
which would let us rebuild balance history beyond Zerion's 1-year chart
cap. That's the next step once this current-state sync is solid.
"""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TypedDict


class TokenMetadata(TypedDict, total=False):
    name: str
    symbol: str
    decimals: int
    logo: str | None

from .. import events
from .. import ledger, positions as positions_mod
from ..db import connect
from ..env import load_env
from ..http import fetch_json

# Alchemy network slugs. Not every chain Zerion tracks is Alchemy-native
# (Zora, Scroll, Avalanche, etc.) — those fall through and are skipped.
_CHAINS = {
    "ethereum": "eth-mainnet",
    "base": "base-mainnet",
    "polygon": "polygon-mainnet",
    "optimism": "opt-mainnet",
    "arbitrum": "arb-mainnet",
}

# CoinGecko platform slugs for the token_price endpoint.
_CG_PLATFORM = {
    "ethereum": "ethereum",
    "base": "base",
    "polygon": "polygon-pos",
    "optimism": "optimistic-ethereum",
    "arbitrum": "arbitrum-one",
}
# CoinGecko coin-id for each chain's native coin (for /simple/price).
_CG_NATIVE_ID = {
    "ethereum": "ethereum",
    "base": "ethereum",
    "polygon": "matic-network",
    "optimism": "ethereum",
    "arbitrum": "ethereum",
}
_NATIVE_SYMBOL = {
    "ethereum": "ETH",
    "base": "ETH",
    "polygon": "MATIC",
    "optimism": "ETH",
    "arbitrum": "ETH",
}
COINGECKO_BASE = "https://api.coingecko.com/api/v3"
COINGECKO_DELAY_SEC = 2.2

# Ignore meaningless dust positions.
MIN_VALUE_USD = 1.0


@dataclass
class AlchemyStats:
    wallets: int = 0
    chains_queried: int = 0
    errors: int = 0
    native_balances: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return {
            "wallets": self.wallets,
            "chains_queried": self.chains_queried,
            "errors": self.errors,
            "native_balances": self.native_balances,
        }


def _api_key() -> str:
    env = load_env()
    key = env.get("ALCHEMY_API_KEY")
    if not key:
        raise RuntimeError(
            "ALCHEMY_API_KEY not set in .env — get a free key at "
            "https://dashboard.alchemy.com/"
        )
    return key


def _rpc_call(chain: str, method: str, params: list[object]) -> object:
    slug = _CHAINS.get(chain)
    if not slug:
        raise ValueError(f"Alchemy doesn't support chain {chain!r}")
    url = f"https://{slug}.g.alchemy.com/v2/{_api_key()}"
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    payload = fetch_json(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    if payload is None:
        return None
    if "error" in payload:
        raise RuntimeError(f"Alchemy {method} error: {payload['error']}")
    return payload.get("result")


def fetch_native_balance(chain: str, address: str) -> int | None:
    """Return the native-coin (ETH / MATIC / etc.) wei-balance, or None
    on network failure. Caller converts to USD via a price source."""
    try:
        result = _rpc_call(chain, "eth_getBalance", [address, "latest"])
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return None
    if not isinstance(result, str) or not result.startswith("0x"):
        return None
    try:
        return int(result, 16)
    except ValueError:
        return None


def _get_wallets() -> list[str]:
    env = load_env()
    raw = (env.get("ZERION_WALLETS") or "").strip()
    if not raw:
        return []
    return [w.strip().lower() for w in raw.split(",") if w.strip()]


def fetch_token_balances(chain: str, address: str) -> list[tuple[str, int]]:
    """Return [(contract_address, raw_balance_int), ...] for ERC-20s the
    wallet holds on this chain. Alchemy returns base-units (not decimal)."""
    try:
        result = _rpc_call(chain, "alchemy_getTokenBalances", [address])
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return []
    out: list[tuple[str, int]] = []
    for bal in (result or {}).get("tokenBalances") or []:
        contract = bal.get("contractAddress")
        raw = bal.get("tokenBalance")
        if not contract or not raw or raw == "0x":
            continue
        try:
            v = int(raw, 16)
        except (TypeError, ValueError):
            continue
        if v > 0:
            out.append((contract.lower(), v))
    return out


def fetch_token_metadata(chain: str, contract: str) -> TokenMetadata | None:
    """Returns {name, symbol, decimals, logo} or None."""
    try:
        return _rpc_call(chain, "alchemy_getTokenMetadata", [contract])
    except Exception:
        return None


def _cg_get(path: str, params: dict[str, str]) -> object:
    return fetch_json(f"{COINGECKO_BASE}{path}?{urllib.parse.urlencode(params)}")


def _native_prices(chains: list[str]) -> dict[str, float]:
    """USD price per distinct CoinGecko native-coin id used by the
    supplied chain set."""
    ids = {_CG_NATIVE_ID[c] for c in chains if c in _CG_NATIVE_ID}
    if not ids:
        return {}
    body = _cg_get("/simple/price", {"ids": ",".join(sorted(ids)), "vs_currencies": "usd"})
    if not isinstance(body, dict):
        return {}
    out: dict[str, float] = {}
    for k, v in body.items():
        if isinstance(v, dict) and "usd" in v:
            out[k] = float(v["usd"])
    return out


def _token_prices(chain: str, contracts: list[str]) -> dict[str, float]:
    """USD price per (lowercased) contract address on `chain`. Empty if
    CoinGecko doesn't know the chain or contracts."""
    if not contracts:
        return {}
    platform = _CG_PLATFORM.get(chain)
    if not platform:
        return {}
    # CoinGecko accepts up to ~100 contracts per call.
    result: dict[str, float] = {}
    for i in range(0, len(contracts), 50):
        chunk = contracts[i : i + 50]
        body = _cg_get(
            f"/simple/token_price/{platform}",
            {"contract_addresses": ",".join(chunk), "vs_currencies": "usd"},
        )
        if isinstance(body, dict):
            for k, v in body.items():
                if isinstance(v, dict) and "usd" in v:
                    result[k.lower()] = float(v["usd"])
        time.sleep(COINGECKO_DELAY_SEC)
    return result


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


def _short(addr: str) -> str:
    return f"{addr[:6]}…{addr[-4:]}"


def sync(_emit_run_brackets: bool = True) -> AlchemyStats:
    """Full wallet positions sync via Alchemy + CoinGecko.

    For each wallet × chain:
      1. Pull native balance via eth_getBalance
      2. Pull ERC-20 balances via alchemy_getTokenBalances
      3. Resolve token decimals + symbol via alchemy_getTokenMetadata
      4. Resolve USD prices via CoinGecko (/simple/price for natives,
         /simple/token_price/{platform} for ERC-20s)
      5. Write account (zerion:<chain>:<addr>), balance row
         (source='alchemy'), and holdings rows (source-less).

    Accounts and balances are UPSERT-style so this is safe alongside
    Zerion — whichever provider ran most recently wins on conflict.

    When `_emit_run_brackets=False`, the caller is responsible for emitting
    `sync_started`/`sync_finished` (used by `finance sync all` to wrap the
    whole run in one bracket).
    """
    stats = AlchemyStats()
    run_id = uuid.uuid4().hex
    if _emit_run_brackets:
        events.sync_started(run_id=run_id, sources=["alchemy"])

    try:
        wallets = _get_wallets()
        if not wallets:
            print("no wallets configured in ZERION_WALLETS")
            if _emit_run_brackets:
                events.sync_finished(
                    run_id=run_id,
                    ok=True,
                    totals={"wallets": 0, "chains_queried": 0, "errors": 0},
                )
            return stats

        native_usd = _native_prices(list(_CHAINS.keys()))
        as_of = datetime.now(tz=timezone.utc).date().isoformat()
        # Token metadata is immutable per (chain, contract) — cache across
        # the whole run so only the first wallet that holds a given token
        # pays the RPC cost. Saves ~80% of alchemy_getTokenMetadata calls in
        # typical portfolios where the same ERC-20s appear on multiple
        # wallets.
        meta_cache: dict[tuple[str, str], TokenMetadata] = {}

        with connect() as conn:
            for addr in wallets:
                stats.wallets += 1
                for chain in _CHAINS:
                    stats.chains_queried += 1
                    wei = fetch_native_balance(chain, addr)
                    tokens = fetch_token_balances(chain, addr)
                    if wei is None and not tokens:
                        stats.errors += 1
                        continue
                    token_meta: dict[str, TokenMetadata] = {}
                    for contract, _ in tokens:
                        cached = meta_cache.get((chain, contract))
                        if cached is not None:
                            token_meta[contract] = cached
                            continue
                        md = fetch_token_metadata(chain, contract)
                        if md:
                            token_meta[contract] = md
                            meta_cache[(chain, contract)] = md
                    prices = _token_prices(chain, list(token_meta.keys()))

                    # (symbol, qty, value_usd, contract_address). Natives have
                    # contract_address='' so the v2 positions row keys on chain
                    # + empty contract (consistent with the zerion parser).
                    wallet_positions: list[tuple[str, float, float, str]] = []
                    native_qty = (wei or 0) / 1e18
                    native_id = _CG_NATIVE_ID.get(chain)
                    native_price = native_usd.get(native_id) if native_id else None
                    if native_qty > 0 and native_price:
                        wallet_positions.append(
                            (_NATIVE_SYMBOL[chain], native_qty, native_qty * native_price, "")
                        )
                    for contract, raw in tokens:
                        md = token_meta.get(contract)
                        if not md:
                            continue
                        decimals = md.get("decimals")
                        symbol = (md.get("symbol") or "").strip()
                        if decimals is None or not symbol:
                            continue
                        qty = raw / (10 ** int(decimals))
                        px = prices.get(contract)
                        if not px:
                            continue
                        val = qty * px
                        if val < MIN_VALUE_USD:
                            continue
                        wallet_positions.append((symbol, qty, val, contract))

                    if not wallet_positions:
                        continue

                    account_id = f"zerion:{chain}:{addr}"
                    events.account_started(account_id=account_id, source="alchemy")
                    try:
                        chain_total = sum(p[2] for p in wallet_positions)
                        _upsert_account(
                            conn, account_id, f"{chain.title()} {_short(addr)}", chain.title()
                        )
                        # Trusted balance snapshot for the walker + per-token
                        # position snapshots for the holdings view.
                        ledger.assert_balance(
                            conn, account_id, as_of, chain_total, source="alchemy"
                        )
                        kept_keys: set[tuple[str, str]] = set()
                        for symbol, qty, val, contract in wallet_positions:
                            positions_mod.upsert_holding(
                                conn,
                                account_id=account_id,
                                symbol=symbol,
                                as_of=as_of,
                                source="alchemy",
                                value_usd=val,
                                chain=chain,
                                contract_address=contract,
                                quantity=qty,
                                asset_class="crypto",
                            )
                            kept_keys.add((symbol, contract))
                        # Mirror the zerion zero-out: any position previously
                        # observed on this account that didn't appear in today's
                        # Alchemy fetch gets a 0 snapshot so the MTM walker's
                        # forward-fill doesn't carry a stale value forever.
                        for prev in conn.execute(
                            "SELECT id, symbol, contract_address FROM positions WHERE account_id = ?",
                            (account_id,),
                        ).fetchall():
                            if (prev[1], prev[2]) in kept_keys:
                                continue
                            positions_mod.record_snapshot(
                                conn,
                                position_id=prev[0],
                                as_of=as_of,
                                source="alchemy",
                                value_usd=0.0,
                                quantity=0.0,
                            )
                        stats.native_balances[f"{addr}:{chain}"] = chain_total
                        print(
                            f"  {_short(addr)}  {chain:10}  {len(wallet_positions)} positions  "
                            f"${chain_total:,.2f}"
                        )
                        events.account_log(
                            account_id=account_id,
                            message=f"wrote {len(wallet_positions)} positions, ${chain_total:,.2f}",
                        )
                        events.account_finished(account_id=account_id, ok=True)
                    except Exception as exc:
                        events.warning(account_id=account_id, message=f"chain {chain}: {exc}")
                        events.account_finished(account_id=account_id, ok=False)
                        raise

        if _emit_run_brackets:
            events.sync_finished(
                run_id=run_id,
                ok=stats.errors == 0,
                totals={
                    "wallets": stats.wallets,
                    "chains_queried": stats.chains_queried,
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
                    "chains_queried": stats.chains_queried,
                    "errors": stats.errors,
                },
            )
        raise


def print_report(stats: AlchemyStats) -> None:
    print()
    print(
        f"wallets: {stats.wallets}  chains queried: {stats.chains_queried}  "
        f"errors: {stats.errors}"
    )
    non_zero = {k: v for k, v in stats.native_balances.items() if v > 0}
    print(f"non-zero native positions: {len(non_zero)}")
