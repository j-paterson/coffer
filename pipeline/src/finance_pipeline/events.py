"""Structured event emission for streaming sync progress to the dashboard.

When the `finance` CLI is invoked with `--events-fd N`, this module writes
one JSON object per line to file descriptor N. When that flag is absent,
every emit helper is a no-op so terminal users see no behavior change.
"""
from __future__ import annotations

import io
import json
import os
from typing import Any

_fd: io.TextIOWrapper | None = None


def init(fd: int | None) -> None:
    """Open `fd` for line-buffered writes. Pass None to disable emission."""
    global _fd
    if _fd is not None:
        _fd.close()
        _fd = None
    if fd is None:
        return
    _fd = os.fdopen(fd, "w", buffering=1)


def close() -> None:
    """Close the events fd. Tests use this to flush before reading."""
    global _fd
    if _fd is not None:
        _fd.close()
        _fd = None


def _emit(event_type: str, **payload: Any) -> None:
    if _fd is None:
        return
    try:
        _fd.write(json.dumps({"type": event_type, **payload}) + "\n")
    except OSError:
        pass


def sync_started(run_id: str, sources: list[str]) -> None:
    _emit("sync_started", run_id=run_id, sources=sources)


def sync_finished(run_id: str, ok: bool, totals: dict) -> None:
    _emit("sync_finished", run_id=run_id, ok=ok, totals=totals)


def account_started(account_id: str, source: str) -> None:
    _emit("account_started", account_id=account_id, source=source)


def account_finished(account_id: str, ok: bool) -> None:
    _emit("account_finished", account_id=account_id, ok=ok)


def account_log(account_id: str, message: str, level: str = "info") -> None:
    _emit("account_log", account_id=account_id, message=message, level=level)


def warning(account_id: str | None, message: str) -> None:
    _emit("warning", account_id=account_id, message=message)
