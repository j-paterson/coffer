"""Minimal .env loader. No dependency on python-dotenv."""
from __future__ import annotations

from pathlib import Path

from .config import PROJECT_ROOT


def load_env(path: Path | None = None) -> dict[str, str]:
    """Read KEY=VALUE lines from a .env file. Lines starting with # are ignored."""
    path = path or (PROJECT_ROOT / ".env")
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env
