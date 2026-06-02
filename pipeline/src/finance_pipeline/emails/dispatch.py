"""Map finance.config.ts email config to backend instances.

Reads db/.cache/email-config.json if present (written by the TS server
from the validated finance.config.ts schema). Falls back to Gmail+Ollama
defaults if the file is missing — useful for manual CLI invocations
when the server isn't running.

Lazy-imports per backend so a user who picks `extractor.backend: "ollama"`
doesn't pay for the Anthropic/OpenAI optional deps even being checked.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .interfaces import EmailFetcher, ReceiptExtractor


class BackendUnavailableError(Exception):
    """Raised when a configured backend's optional deps aren't installed."""


def _config_path() -> Path:
    """Return the path to the server-generated config cache.

    The path is computed relative to PROJECT_ROOT — handled by config.py.
    """
    from ..config import PROJECT_ROOT
    return PROJECT_ROOT / "db" / ".cache" / "email-config.json"


def _load_config() -> dict[str, Any]:
    """Load the cached email config, or return the default."""
    path = _config_path()
    if not path.exists():
        return {
            "fetcher": {"backend": "gmail"},
            "extractor": {"backend": "ollama"},
        }
    with path.open() as f:
        return json.load(f)


def get_fetcher() -> EmailFetcher:
    """Return the configured EmailFetcher instance."""
    cfg = _load_config()
    fetcher_cfg = cfg["fetcher"]
    backend = fetcher_cfg.get("backend")
    if backend == "gmail":
        from .fetchers.gmail import GmailFetcher
        return GmailFetcher(
            max_results=fetcher_cfg.get("max_results"),
            query=fetcher_cfg.get("query"),
        )
    if backend == "imap":
        try:
            from .fetchers.imap import IMAPFetcher
        except ImportError:
            raise BackendUnavailableError(
                "IMAP fetcher backend not yet implemented (lands in B2.1)."
            )
        return IMAPFetcher(**{k: v for k, v in fetcher_cfg.items() if k != "backend"})
    if backend == "manual":
        try:
            from .fetchers.manual import ManualFetcher
        except ImportError:
            raise BackendUnavailableError(
                "Manual fetcher backend not yet implemented (lands in B2.2)."
            )
        return ManualFetcher(drop_directory=fetcher_cfg["drop_directory"])
    raise ValueError(f"Unknown email fetcher backend: {backend!r}")


def get_extractor() -> ReceiptExtractor:
    """Return the configured ReceiptExtractor instance."""
    cfg = _load_config()
    extractor_cfg = cfg["extractor"]
    backend = extractor_cfg.get("backend")
    if backend == "ollama":
        from .extractors.ollama import OllamaExtractor
        return OllamaExtractor(
            url=extractor_cfg.get("url"),
            model=extractor_cfg.get("model"),
        )
    if backend == "anthropic":
        try:
            from .extractors.anthropic_api import AnthropicExtractor
        except ImportError:
            raise BackendUnavailableError(
                "Anthropic extractor backend not yet implemented (lands in B3.1)."
            )
        return AnthropicExtractor(**{k: v for k, v in extractor_cfg.items() if k != "backend"})
    if backend == "openai":
        try:
            from .extractors.openai_api import OpenAIExtractor
        except ImportError:
            raise BackendUnavailableError(
                "OpenAI extractor backend not yet implemented (lands in B3.2)."
            )
        return OpenAIExtractor(**{k: v for k, v in extractor_cfg.items() if k != "backend"})
    raise ValueError(f"Unknown email extractor backend: {backend!r}")
