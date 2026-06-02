"""ABCs for the email receipt extraction pipeline.

Two contracts:
  - EmailFetcher: yields .eml file paths for downstream processing.
  - ReceiptExtractor: parses an .eml into an ExtractedReceipt dataclass.

Backends live in fetchers/ and extractors/ subpackages. Backend selection
is driven by finance.config.ts under parsers.email.fetcher.backend and
parsers.email.extractor.backend.

The ExtractedReceipt fields mirror what NuExtract produces. Backends that
can't fill a field leave it blank (string) or None (numeric) — extractive
contract, no hallucination.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator


@dataclass
class ExtractedReceipt:
    merchant: str
    date: str
    currency: str
    subtotal: float | None
    tax: float | None
    total: float | None
    payment_method: str
    order_id: str
    items: list[dict[str, object]] = field(default_factory=list)


class EmailFetcher(ABC):
    """Yields .eml file paths the system hasn't processed yet."""

    @abstractmethod
    def fetch_new(self) -> Iterator[Path]:
        """Yield Paths of newly-fetched .eml files in the local cache."""

    @abstractmethod
    def mark_processed(self, email_id: str) -> None:
        """Record that an email has been fully processed downstream."""


class ReceiptExtractor(ABC):
    """Parses an .eml file into structured receipt fields."""

    @abstractmethod
    def extract(self, eml_path: Path) -> ExtractedReceipt:
        """Read the .eml, return an ExtractedReceipt. Blank fields stay blank."""
