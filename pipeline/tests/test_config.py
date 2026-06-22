"""Tests for project path resolution, esp. the FINANCE_DB override."""
from __future__ import annotations

import importlib
from pathlib import Path


def _reload_config():
    import finance_pipeline.config as config
    return importlib.reload(config)


def test_db_path_defaults_to_in_repo(monkeypatch):
    monkeypatch.delenv("FINANCE_DB", raising=False)
    config = _reload_config()
    try:
        assert config.DB_PATH == config.DB_DIR / "finance.sqlite"
    finally:
        _reload_config()  # restore module state for other tests


def test_db_path_honors_finance_db(monkeypatch, tmp_path):
    target = tmp_path / "elsewhere" / "finance.sqlite"
    monkeypatch.setenv("FINANCE_DB", str(target))
    config = _reload_config()
    try:
        assert config.DB_PATH == target.resolve()
        # Migrations still resolve against the repo, not the relocated DB.
        assert config.MIGRATIONS_DIR == config.DB_DIR / "migrations"
    finally:
        monkeypatch.delenv("FINANCE_DB", raising=False)
        _reload_config()
