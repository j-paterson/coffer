"""SimpleFIN Bridge parser.

SimpleFIN is a read-only HTTP API that returns bank accounts, balances, and
transactions as JSON. We treat each /accounts response as a 'snapshot' with
as_of = the date of the fetch.

Protocol notes:
- Access URL format: https://USER:PASS@host/simplefin
- Accounts endpoint: <access_url>/accounts
- Date range query params: start-date, end-date (unix seconds). Max 90 days per request.
- The 'pending' query param (0/1) toggles whether pending transactions are included.
  We default to excluding them to keep the transactions table stable.

Amount convention: SimpleFIN returns signed amounts (negative = outflow / debt).
This matches our internal convention, so no transformation is needed.
"""
from __future__ import annotations

import base64
import json
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit, urlunsplit

from .base import (
    AccountRow,
    BalanceRow,
    HoldingRow,
    ParseResult,
    TransactionRow,
)
from ..location import extract_location


def _account_type_from_simplefin(account: dict[str, object]) -> str:
    """Infer our account type from SimpleFIN's reported org and account metadata.

    SimpleFIN doesn't have a formal 'type' field — we infer from balance sign
    and name hints. Negative balance + 'credit'/'card'/'visa' in name → credit.
    Otherwise default to 'checking' (safe guess for liquid accounts).
    """
    name = (account.get("name") or "").lower()
    org = account.get("org") or {}
    org_name = ""
    if isinstance(org, dict):
        org_name = (org.get("name") or org.get("domain") or "").lower()
    try:
        bal = float(account.get("balance", "0"))
    except (TypeError, ValueError):
        bal = 0.0

    # Crypto exchanges: classify as crypto regardless of balance sign.
    crypto_orgs = ("coinbase", "kraken", "gemini", "binance")
    if any(k in org_name for k in crypto_orgs):
        return "crypto"

    is_credit_hint = any(
        kw in name
        for kw in (
            "credit",
            "visa",
            "mastercard",
            "amex",
            " card",
            "rewards",
            "freedom",
            "unlimited",
            "sapphire",
            "preferred",
            "venture",
            "platinum",
            "gold",
            "reserve",
        )
    )
    if bal < 0 or is_credit_hint:
        return "credit"
    if "saving" in name:
        return "savings"
    if "invest" in name or "brokerage" in name:
        return "brokerage"
    if "retire" in name or "401" in name or "ira" in name:
        return "retirement"
    return "checking"


def _iso_from_unix(ts: int | float | str | None) -> str:
    if ts is None or ts == "" or ts == 0:
        return ""
    try:
        n = int(float(ts))
    except (TypeError, ValueError):
        return ""
    return datetime.fromtimestamp(n, tz=timezone.utc).date().isoformat()


def _parse_amount(v: object) -> float:
    """SimpleFIN returns amounts as strings to preserve precision."""
    if v is None:
        return 0.0
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return 0.0


def _split_basic_auth(url: str) -> tuple[str, str | None]:
    """Extract HTTP Basic Auth creds from a URL.

    Python's urllib.request can't handle user:pass@host URLs (it mis-parses
    the colon as a port). We split the credentials out and return (clean_url,
    basic_auth_header) so the caller can pass the header manually.
    """
    parsed = urlsplit(url)
    if "@" not in parsed.netloc:
        return url, None
    auth, _, host = parsed.netloc.rpartition("@")
    clean = urlunsplit(
        (parsed.scheme, host, parsed.path, parsed.query, parsed.fragment)
    )
    encoded = base64.b64encode(auth.encode()).decode()
    return clean, f"Basic {encoded}"


_SIMPLEFIN_MAX_WINDOW_DAYS = 90


def _fetch_window(
    access_url: str,
    start_ts: int,
    end_ts: int,
    include_pending: bool,
) -> dict[str, object]:
    """Single /accounts call for a given [start_ts, end_ts] range."""
    params = {
        "start-date": str(start_ts),
        "end-date": str(end_ts),
        "pending": "1" if include_pending else "0",
    }
    clean_url, auth_header = _split_basic_auth(access_url)
    url = f"{clean_url.rstrip('/')}/accounts?{urlencode(params)}"
    headers: dict[str, str] = {
        "User-Agent": "finance-pipeline/0.1 (+local)",
        "Accept": "application/json",
    }
    if auth_header:
        headers["Authorization"] = auth_header
    req = urllib.request.Request(url, method="GET", headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 200:
            raise RuntimeError(f"SimpleFIN /accounts returned {resp.status}")
        return json.loads(resp.read().decode("utf-8"))


def fetch_accounts(
    access_url: str,
    start_days: int = 90,
    include_pending: bool = False,
) -> dict[str, object]:
    """GET /accounts.

    SimpleFIN caps each request at 90 days. When `start_days` exceeds that,
    we paginate in 90-day chunks and merge the transactions from each
    window. Account + balance + holdings payloads are taken from the most
    recent chunk (these reflect current state, not the query window).
    """
    now = int(datetime.now(tz=timezone.utc).timestamp())
    if start_days <= _SIMPLEFIN_MAX_WINDOW_DAYS:
        return _fetch_window(
            access_url,
            now - start_days * 86400,
            now,
            include_pending,
        )

    # Multi-window pagination.
    windows: list[dict[str, object]] = []
    end = now
    remaining = start_days
    while remaining > 0:
        days_this = min(_SIMPLEFIN_MAX_WINDOW_DAYS, remaining)
        start = end - days_this * 86400
        windows.append(_fetch_window(access_url, start, end, include_pending))
        end = start
        remaining -= days_this

    # Merge. First window (most recent) is the source of truth for accounts
    # / balances / holdings. Union transactions by id across every window.
    base = windows[0]
    merged_accounts: list[dict[str, object]] = []
    # Keep the per-account transaction set indexed by SimpleFIN acct id.
    txn_by_account: dict[str, dict[str, dict[str, object]]] = {}
    for w in windows:
        for acct in w.get("accounts", []) or []:
            sf_id = acct.get("id")
            if not sf_id:
                continue
            bucket = txn_by_account.setdefault(sf_id, {})
            for txn in acct.get("transactions", []) or []:
                tid = txn.get("id")
                if not tid or tid in bucket:
                    continue
                bucket[tid] = txn

    for acct in base.get("accounts", []) or []:
        sf_id = acct.get("id")
        if not sf_id:
            merged_accounts.append(acct)
            continue
        merged_accounts.append({
            **acct,
            "transactions": list(txn_by_account.get(sf_id, {}).values()),
        })

    errlist: list[object] = []
    for w in windows:
        for err in w.get("errlist", []) or []:
            if err not in errlist:
                errlist.append(err)

    return {"accounts": merged_accounts, "errlist": errlist}


def parse(data: dict[str, object], as_of: str | None = None) -> ParseResult:
    """Map a SimpleFIN /accounts response to a ParseResult."""
    result = ParseResult()
    as_of = as_of or datetime.now(tz=timezone.utc).date().isoformat()
    source = f"simplefin:{as_of}"

    # Propagate errors as warnings
    for err in data.get("errlist", []) or []:
        result.warnings.append(f"simplefin errlist: {err}")

    for acct in data.get("accounts", []) or []:
        sf_id = acct.get("id")
        if not sf_id:
            continue

        acct_id = f"simplefin:{sf_id}"
        name = (acct.get("name") or "").strip() or "(unnamed)"
        org = acct.get("org") or {}
        institution = (
            (org.get("name") if isinstance(org, dict) else None)
            or (org.get("domain") if isinstance(org, dict) else None)
            or "Unknown"
        )
        currency = (acct.get("currency") or "USD").strip() or "USD"
        balance = _parse_amount(acct.get("balance"))
        acct_type = _account_type_from_simplefin(acct)

        result.accounts.append(
            AccountRow(
                id=acct_id,
                display_name=name,
                institution=institution,
                type=acct_type,
                currency=currency,
                active=1,
            )
        )

        result.balances.append(
            BalanceRow(
                account_id=acct_id,
                as_of=as_of,
                value_usd=balance,
                source="simplefin",
            )
        )

        for txn in acct.get("transactions", []) or []:
            sf_txn_id = txn.get("id")
            if not sf_txn_id:
                continue
            posted = txn.get("posted") or txn.get("transacted_at")
            date_iso = _iso_from_unix(posted)
            if not date_iso:
                result.warnings.append(
                    f"skipping txn with no date: acct={sf_id} id={sf_txn_id}"
                )
                continue
            amount = _parse_amount(txn.get("amount"))
            description = (txn.get("description") or "").strip()
            payee = (txn.get("payee") or "").strip() or None
            memo = (txn.get("memo") or "").strip() or None
            location_hint = extract_location(description, payee)

            # Stable, traceable composite id.
            txn_id = f"sf:{sf_id}:{sf_txn_id}"

            result.transactions.append(
                TransactionRow(
                    id=txn_id,
                    account_id=acct_id,
                    date=date_iso,
                    amount=amount,
                    description=description,
                    merchant=None,  # categorization fills this in later
                    source_file=source,
                    notes=None,
                    tags="pending" if txn.get("pending") else None,
                    payee=payee,
                    memo=memo,
                    location_hint=location_hint,
                )
            )

        # Investment holdings (SimpleFIN optional field — populated for
        # brokerage/retirement accounts at institutions that expose it).
        # Fields per SimpleFIN spec: symbol, shares, market_value,
        # cost_basis, description, purchase_price, currency.
        for hold in acct.get("holdings", []) or []:
            symbol = (hold.get("symbol") or "").strip()
            if not symbol:
                # Some institutions omit symbol for cash-equivalent sweeps;
                # fall back to description so we still capture the value.
                symbol = (hold.get("description") or "").strip()[:32] or "UNKNOWN"
            market_value = _parse_amount(hold.get("market_value"))
            shares = hold.get("shares")
            quantity = float(shares) if shares not in (None, "") else None
            cost = hold.get("cost_basis")
            cost_basis = float(cost) if cost not in (None, "") else None
            result.holdings.append(
                HoldingRow(
                    account_id=acct_id,
                    as_of=as_of,
                    symbol=symbol,
                    asset_class=None,
                    quantity=quantity,
                    value_usd=market_value,
                    cost_basis=cost_basis,
                )
            )

    return result
