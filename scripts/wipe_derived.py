#!/usr/bin/env python3
"""Wipe all derived data so the pipeline can re-ingest from raw sources.

Preserves:
  - accounts (manual metadata like display_name_override and type)
  - sender_profiles (email-receipt classifier state)
  - schema_migrations (don't re-run migrations)
  - rules / user-curated config
  - provider_cache (avoid hitting rate limits on immediate re-sync)

Wipes:
  - All v2 derived tables (raw_events, transactions_v2, postings, event_links,
    balance_assertions, reconciliation_notes)
  - transaction_items + receipts (derived from transactions — must be wiped
    since their FKs would break)
  - sync_warnings

Makes a timestamped backup before touching anything.
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "db" / "finance.sqlite"
BACKUPS = ROOT / "backups"

TABLES_TO_WIPE = [
    # children first
    "event_links",
    "postings",
    "reconciliation_notes",
    "transaction_items",
    "transactions_v2",
    "balance_assertions",
    "raw_events",
    "sync_warnings",
]


def main() -> int:
    if not DB.exists():
        print(f"no db at {DB}")
        return 1
    BACKUPS.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = BACKUPS / f"finance_pre_wipe_{ts}.sqlite"
    shutil.copy(DB, backup)
    print(f"backup: {backup}")

    conn = sqlite3.connect(DB)
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        for t in TABLES_TO_WIPE:
            cur = conn.execute(f"DELETE FROM {t}")
            print(f"  wiped {t:<25} ({cur.rowcount} rows)")
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
