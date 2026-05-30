"""Pull EVM wallet addresses out of the latest Kubera JSON export.

Run once: prints the distinct wallet addresses (and which accounts
reference each). The output is intended to be pasted into a config or
loaded by the sync module.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from finance_pipeline.config import RAW_KUBERA

ETH_ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")


def main() -> int:
    exports = sorted(RAW_KUBERA.iterdir(), reverse=True)
    if not exports:
        print("no Kubera exports found", file=sys.stderr)
        return 1
    latest = exports[0]
    path = latest / "Financial.json"
    data = json.loads(path.read_text())

    # connection.id is the wallet address; the top-level asset.id is the
    # token/contract. We collect distinct wallet addresses.
    wallets: dict[str, list[str]] = {}
    for asset in data.get("asset", []):
        conn = asset.get("connection") or {}
        conn_id = (conn.get("id") or "").strip()
        if not ETH_ADDR_RE.match(conn_id):
            continue
        # Normalize to lowercase for dedup; Zerion accepts both.
        addr = conn_id.lower()
        name = asset.get("name") or "(unnamed)"
        wallets.setdefault(addr, []).append(name)

    print(f"# {len(wallets)} distinct EVM wallet address(es)")
    print(f"# extracted from {path.relative_to(path.parent.parent.parent)}")
    print()
    for addr, names in sorted(wallets.items(), key=lambda x: -len(x[1])):
        print(f"{addr}")
        for n in names[:6]:
            print(f"    # {n[:70]}")
        if len(names) > 6:
            print(f"    # ... +{len(names) - 6} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
