"""Dispatch maps config -> backend instances."""
import json
from pathlib import Path
import pytest
from finance_pipeline.emails import dispatch
from finance_pipeline.emails.interfaces import EmailFetcher, ReceiptExtractor


@pytest.fixture
def no_config(monkeypatch, tmp_path):
    """Point dispatch at a tmp dir with no config file."""
    monkeypatch.setattr(dispatch, "_config_path", lambda: tmp_path / "nope.json")


@pytest.fixture
def with_config(monkeypatch, tmp_path):
    """Allow tests to write a config file dispatch will read."""
    cfg_path = tmp_path / "email-config.json"
    monkeypatch.setattr(dispatch, "_config_path", lambda: cfg_path)
    return cfg_path


def test_default_when_no_config(no_config):
    """No config file → Gmail + Ollama defaults."""
    fetcher = dispatch.get_fetcher()
    extractor = dispatch.get_extractor()
    assert isinstance(fetcher, EmailFetcher)
    assert isinstance(extractor, ReceiptExtractor)
    assert fetcher.__class__.__name__ == "GmailFetcher"
    assert extractor.__class__.__name__ == "OllamaExtractor"


def test_gmail_with_explicit_config(with_config):
    with_config.write_text(json.dumps({
        "fetcher": {"backend": "gmail", "max_results": 50, "query": "label:receipts"},
        "extractor": {"backend": "ollama"},
    }))
    fetcher = dispatch.get_fetcher()
    assert fetcher.__class__.__name__ == "GmailFetcher"
    assert fetcher.max_results == 50
    assert fetcher.query == "label:receipts"


def test_unknown_fetcher_backend(with_config):
    with_config.write_text(json.dumps({
        "fetcher": {"backend": "carrier-pigeon"},
        "extractor": {"backend": "ollama"},
    }))
    with pytest.raises(ValueError, match="Unknown email fetcher backend"):
        dispatch.get_fetcher()


def test_unknown_extractor_backend(with_config):
    with_config.write_text(json.dumps({
        "fetcher": {"backend": "gmail"},
        "extractor": {"backend": "tea-leaves"},
    }))
    with pytest.raises(ValueError, match="Unknown email extractor backend"):
        dispatch.get_extractor()


def test_unimplemented_backends_raise_friendly_error(with_config):
    """IMAP/manual/anthropic/openai not landed yet — raise BackendUnavailableError."""
    with_config.write_text(json.dumps({
        "fetcher": {"backend": "imap", "host": "imap.example.com", "username_env": "FOO", "password_env": "BAR"},
        "extractor": {"backend": "ollama"},
    }))
    with pytest.raises(dispatch.BackendUnavailableError, match="lands in B2.1"):
        dispatch.get_fetcher()


def test_malformed_config_falls_back_to_defaults(with_config, capsys):
    """A malformed JSON cache file logs a warning and uses defaults."""
    with_config.write_text("{ this is not valid json")
    fetcher = dispatch.get_fetcher()
    assert fetcher.__class__.__name__ == "GmailFetcher"
    err = capsys.readouterr().err
    assert "malformed" in err
