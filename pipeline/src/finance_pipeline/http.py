"""Shared HTTP helpers.

Every provider adapter (Zerion, Alchemy, CoinGecko, Yahoo, SimpleFIN)
ended up duplicating the same try/except + 429-backoff urllib wrapper.
This module is the single source of truth. Callers supply URL, headers,
and body; we return parsed JSON or ``None`` on failure.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Union

JsonValue = Union[dict[str, "JsonValue"], list["JsonValue"], str, int, float, bool, None]

DEFAULT_UA = "finance-pipeline/0.1 (+local)"
DEFAULT_ACCEPT = "application/json"


def fetch_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    method: str = "GET",
    timeout: float = 30.0,
    retries: int = 4,
    base_backoff: float = 2.0,
) -> JsonValue:
    """GET or POST JSON with 429-aware exponential backoff.

    Returns parsed JSON on success, ``None`` on any network error or
    HTTP failure. Rate-limit (429) responses get ``base_backoff * 2**i``
    seconds of sleep between retries up to ``retries`` times; other
    HTTPErrors return None immediately (no point retrying a 404).
    """
    h = {"User-Agent": DEFAULT_UA, "Accept": DEFAULT_ACCEPT}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(base_backoff * (2 ** attempt))
                continue
            return None
        except (urllib.error.URLError, TimeoutError):
            return None
    return None
