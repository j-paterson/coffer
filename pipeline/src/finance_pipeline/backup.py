"""SQLite backup automation.

Writes a gzipped SQL dump of the database to backups/finance-YYYY-MM-DD.sql.gz.
Uses sqlite3's built-in iterdump() so it works on a hot database without
needing to stop the API.
"""
from __future__ import annotations

import gzip
import sqlite3
from datetime import datetime
from pathlib import Path

from .config import BACKUPS_DIR, DB_PATH


def backup(
    db_path: Path = DB_PATH,
    backups_dir: Path = BACKUPS_DIR,
    keep: int = 30,
) -> Path:
    """Write a gzipped SQL dump of the database. Returns the file path.

    Also prunes the backups directory to the most recent `keep` files
    (matched on the same naming pattern) so it doesn't grow without bound.
    """
    backups_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    out_path = backups_dir / f"finance-{timestamp}.sql.gz"

    conn = sqlite3.connect(db_path)
    try:
        with gzip.open(out_path, "wt", encoding="utf-8") as f:
            for line in conn.iterdump():
                f.write(line)
                f.write("\n")
    finally:
        conn.close()

    # Prune older backups
    existing = sorted(
        backups_dir.glob("finance-*.sql.gz"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    pruned = 0
    for old in existing[keep:]:
        old.unlink()
        pruned += 1

    size = out_path.stat().st_size
    print(f"wrote {out_path.name} ({size:,} bytes)")
    if pruned:
        print(f"pruned {pruned} older backup(s) (keeping {keep})")
    return out_path
