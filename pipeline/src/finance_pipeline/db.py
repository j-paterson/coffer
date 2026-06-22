"""SQLite connection and migration runner."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import DB_PATH, MIGRATIONS_DIR


SCHEMA_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


@contextmanager
def connect(db_path: Path = DB_PATH) -> Iterator[sqlite3.Connection]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def applied_versions(conn: sqlite3.Connection) -> set[str]:
    conn.execute(SCHEMA_TABLE_SQL)
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    return {row["version"] for row in rows}


def pending_migrations(
    conn: sqlite3.Connection,
    migrations_dir: Path = MIGRATIONS_DIR,
) -> list[Path]:
    applied = applied_versions(conn)
    all_files = sorted(migrations_dir.glob("*.sql"))
    return [f for f in all_files if f.stem not in applied]


def migrate(
    db_path: Path = DB_PATH,
    migrations_dir: Path = MIGRATIONS_DIR,
) -> list[str]:
    """Apply all pending migrations. Returns list of versions applied."""
    applied_now: list[str] = []
    with connect(db_path) as conn:
        for path in pending_migrations(conn, migrations_dir):
            sql = path.read_text()
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO schema_migrations (version) VALUES (?)",
                (path.stem,),
            )
            applied_now.append(path.stem)
    return applied_now
