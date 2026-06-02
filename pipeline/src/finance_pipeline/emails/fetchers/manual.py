"""Manual file-drop fetcher.

Implements EmailFetcher for users who want to forward receipts to the
local machine (e.g. forwarded from a phone via airdrop, drag-dropped
from an email client). Scans a configured directory for .eml files
and yields them in modification-time order. Idempotent across runs
via a hidden state file in the directory.

Source files are not deleted or moved — the directory remains the
user's source of truth.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from ..interfaces import EmailFetcher


class ManualFetcher(EmailFetcher):
    STATE_FILENAME = ".processed"

    def __init__(self, drop_directory: str) -> None:
        self.drop_directory = Path(drop_directory)

    def _state_path(self) -> Path:
        return self.drop_directory / self.STATE_FILENAME

    def _load_state(self) -> set[str]:
        path = self._state_path()
        if not path.exists():
            return set()
        try:
            with path.open() as f:
                return set(json.load(f))
        except json.JSONDecodeError:
            # Corrupted state file → start fresh
            return set()

    def _save_state(self, processed: set[str]) -> None:
        with self._state_path().open("w") as f:
            json.dump(sorted(processed), f)

    def fetch_new(self) -> Iterator[Path]:
        if not self.drop_directory.exists():
            raise SystemExit(
                f"Manual fetcher drop directory does not exist: {self.drop_directory}. "
                f"Create the directory and drop .eml files there. See docs/email.md."
            )
        processed = self._load_state()
        eml_files = sorted(
            self.drop_directory.glob("*.eml"),
            key=lambda p: p.stat().st_mtime,
        )
        for path in eml_files:
            if path.name in processed:
                continue
            yield path

    def mark_processed(self, email_id: str) -> None:
        processed = self._load_state()
        processed.add(email_id)
        self._save_state(processed)
