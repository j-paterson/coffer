"""Tests for IMAPFetcher using a fake IMAP client.

We don't spin up a real IMAP server. Instead we monkeypatch
imaplib.IMAP4_SSL (and IMAP4) to return a FakeIMAP object that records
calls and returns canned responses. The fetcher contract is what's being
tested — the actual IMAP wire protocol is the stdlib's problem.
"""
from __future__ import annotations

import imaplib
from pathlib import Path

import pytest

# Import the real IMAP4.error class *before* tests monkeypatch imaplib.IMAP4
# with a factory function — otherwise attribute access breaks at test time.
from finance_pipeline.emails.fetchers.imap import IMAPFetcher, _IMAP4Error


# ---------------------------------------------------------------------------
# Fake IMAP client
# ---------------------------------------------------------------------------

class FakeIMAP:
    """Minimal stand-in for imaplib.IMAP4_SSL / IMAP4."""

    def __init__(self, host: str, port: int = 993) -> None:
        self.host = host
        self.port = port
        # Configurable canned responses
        self.login_response: tuple[str, list] = ("OK", [b"Logged in"])
        self.search_response: tuple[str, list[bytes]] = ("OK", [b""])
        self.fetch_responses: dict[bytes, tuple[str, list]] = {}
        self.store_calls: list[tuple[bytes, str, str]] = []
        self.selected_folder: str | None = None
        self.logged_out: bool = False

    def login(self, user: str, pw: str) -> tuple[str, list]:
        typ, data = self.login_response
        if typ != "OK":
            raise _IMAP4Error(f"Login failed: {data}")
        return (typ, data)

    def select(self, folder: str) -> tuple[str, list]:
        self.selected_folder = folder
        return ("OK", [b"1"])

    def uid(self, cmd: str, *args):
        if cmd == "SEARCH":
            return self.search_response
        if cmd == "FETCH":
            uid = args[0]
            return self.fetch_responses.get(uid, ("OK", []))
        if cmd == "STORE":
            self.store_calls.append((args[0], args[1], args[2]))
            return ("OK", [b""])
        raise ValueError(f"Unhandled IMAP UID command: {cmd!r}")

    def logout(self) -> tuple[str, list]:
        self.logged_out = True
        return ("BYE", [b"Logging out"])


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_imap_factory(monkeypatch):
    """Patches imaplib.IMAP4_SSL and IMAP4 with a factory that records instances.

    Returns a list; each time a FakeIMAP is constructed it's appended here.
    Callers can pre-configure behaviour by mutating instances[0] after calling
    the function that triggers the constructor (fetch_new, etc.), OR they can
    configure a shared config dict via the configure() helper below.
    """
    instances: list[FakeIMAP] = []
    config: dict = {}

    def factory(host: str, port: int = 993) -> FakeIMAP:
        inst = FakeIMAP(host, port)
        if "login_response" in config:
            inst.login_response = config["login_response"]
        if "search_response" in config:
            inst.search_response = config["search_response"]
        if "fetch_responses" in config:
            inst.fetch_responses = config["fetch_responses"]
        instances.append(inst)
        return inst

    monkeypatch.setattr("imaplib.IMAP4_SSL", factory)
    monkeypatch.setattr("imaplib.IMAP4", factory)

    factory.instances = instances
    factory.config = config
    return factory


@pytest.fixture
def imap_creds(monkeypatch):
    monkeypatch.setenv("IMAP_USERNAME", "user@example.com")
    monkeypatch.setenv("IMAP_PASSWORD", "secret-pw")


def _make_fetcher(**kwargs) -> IMAPFetcher:
    defaults = dict(
        host="imap.example.com",
        port=993,
        use_ssl=True,
        username_env="IMAP_USERNAME",
        password_env="IMAP_PASSWORD",
        folder="INBOX",
    )
    defaults.update(kwargs)
    return IMAPFetcher(**defaults)


# ---------------------------------------------------------------------------
# Tests: fetch_new
# ---------------------------------------------------------------------------

def test_fetch_new_returns_empty_when_no_unseen(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """fetch_new yields nothing when the server reports no UNSEEN messages."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)
    # Default search_response is ("OK", [b""]) — empty UID list
    fetcher = _make_fetcher()
    paths = list(fetcher.fetch_new())
    assert paths == []


def test_fetch_new_yields_paths_for_unseen_messages(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """fetch_new yields a Path for each UNSEEN UID."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)

    sample_eml = b"From: sender@example.com\r\nSubject: Receipt\r\n\r\nBody"

    fake_imap_factory.config["search_response"] = ("OK", [b"11 22"])
    fake_imap_factory.config["fetch_responses"] = {
        b"11": ("OK", [(b"11 (RFC822 {N})", sample_eml), b")"]),
        b"22": ("OK", [(b"22 (RFC822 {N})", sample_eml), b")"]),
    }

    fetcher = _make_fetcher()
    paths = list(fetcher.fetch_new())

    assert len(paths) == 2
    assert (tmp_path / "imap-11.eml") in paths
    assert (tmp_path / "imap-22.eml") in paths
    # Files actually written
    assert (tmp_path / "imap-11.eml").read_bytes() == sample_eml
    assert (tmp_path / "imap-22.eml").read_bytes() == sample_eml


def test_fetch_new_connects_to_configured_host_and_folder(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """IMAPFetcher connects to the host/folder from its config."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)

    fetcher = _make_fetcher(host="mail.fastmail.com", port=993, folder="Receipts")
    list(fetcher.fetch_new())

    inst = fake_imap_factory.instances[0]
    assert inst.host == "mail.fastmail.com"
    assert inst.port == 993
    assert inst.selected_folder == "Receipts"


def test_fetch_new_uses_ssl_when_configured(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """use_ssl=True means IMAP4_SSL is used (not plain IMAP4)."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)

    ssl_instances: list[str] = []
    plain_instances: list[str] = []

    def ssl_factory(host, port=993):
        inst = FakeIMAP(host, port)
        ssl_instances.append(host)
        return inst

    def plain_factory(host, port=993):
        inst = FakeIMAP(host, port)
        plain_instances.append(host)
        return inst

    monkeypatch.setattr("imaplib.IMAP4_SSL", ssl_factory)
    monkeypatch.setattr("imaplib.IMAP4", plain_factory)

    list(_make_fetcher(use_ssl=True).fetch_new())
    assert len(ssl_instances) == 1
    assert len(plain_instances) == 0


def test_fetch_new_uses_plain_imap_when_ssl_false(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """use_ssl=False means plain IMAP4 is used."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)

    ssl_instances: list[str] = []
    plain_instances: list[str] = []

    def ssl_factory(host, port=993):
        inst = FakeIMAP(host, port)
        ssl_instances.append(host)
        return inst

    def plain_factory(host, port=993):
        inst = FakeIMAP(host, port)
        plain_instances.append(host)
        return inst

    monkeypatch.setattr("imaplib.IMAP4_SSL", ssl_factory)
    monkeypatch.setattr("imaplib.IMAP4", plain_factory)

    list(_make_fetcher(use_ssl=False).fetch_new())
    assert len(plain_instances) == 1
    assert len(ssl_instances) == 0


def test_fetch_new_logs_out_after_iteration(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """fetch_new always calls logout() when finished — even if inbox is empty."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)
    list(_make_fetcher().fetch_new())
    assert fake_imap_factory.instances[0].logged_out is True


# ---------------------------------------------------------------------------
# Tests: credential handling
# ---------------------------------------------------------------------------

def test_missing_credential_env_raises_systemexit(fake_imap_factory, monkeypatch):
    """Unset env vars produce a SystemExit pointing to docs/email.md."""
    monkeypatch.delenv("IMAP_USERNAME", raising=False)
    monkeypatch.delenv("IMAP_PASSWORD", raising=False)

    fetcher = _make_fetcher()
    with pytest.raises(SystemExit) as exc_info:
        list(fetcher.fetch_new())

    assert "docs/email.md" in str(exc_info.value)


def test_missing_username_only_raises_systemexit(fake_imap_factory, monkeypatch):
    """Only IMAP_USERNAME missing → SystemExit with docs/email.md hint."""
    monkeypatch.delenv("IMAP_USERNAME", raising=False)
    monkeypatch.setenv("IMAP_PASSWORD", "pw")

    fetcher = _make_fetcher()
    with pytest.raises(SystemExit) as exc_info:
        list(fetcher.fetch_new())

    assert "docs/email.md" in str(exc_info.value)


def test_missing_password_only_raises_systemexit(fake_imap_factory, monkeypatch):
    """Only IMAP_PASSWORD missing → SystemExit with docs/email.md hint."""
    monkeypatch.setenv("IMAP_USERNAME", "user@example.com")
    monkeypatch.delenv("IMAP_PASSWORD", raising=False)

    fetcher = _make_fetcher()
    with pytest.raises(SystemExit) as exc_info:
        list(fetcher.fetch_new())

    assert "docs/email.md" in str(exc_info.value)


def test_login_failure_raises_systemexit(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """A failed IMAP login raises SystemExit with docs/email.md hint."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)
    # Configure login to raise IMAP4.error (simulating "NO Login failed")
    fake_imap_factory.config["login_response"] = ("NO", [b"Login failed"])

    fetcher = _make_fetcher()
    with pytest.raises(SystemExit) as exc_info:
        list(fetcher.fetch_new())

    assert "docs/email.md" in str(exc_info.value)


def test_credentials_passed_to_login(fake_imap_factory, monkeypatch, tmp_path):
    """The correct username/password from env vars are forwarded to login()."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)
    monkeypatch.setenv("MY_USER", "alice@example.com")
    monkeypatch.setenv("MY_PASS", "hunter2")

    # Override login to capture creds without error
    captured: list[tuple[str, str]] = []
    orig_login = FakeIMAP.login

    def capturing_login(self, user, pw):
        captured.append((user, pw))
        return orig_login(self, user, pw)

    monkeypatch.setattr(FakeIMAP, "login", capturing_login)

    fetcher = _make_fetcher(username_env="MY_USER", password_env="MY_PASS")
    list(fetcher.fetch_new())

    assert captured == [("alice@example.com", "hunter2")]


# ---------------------------------------------------------------------------
# Tests: mark_processed
# ---------------------------------------------------------------------------

def test_mark_processed_sends_uid_store(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """mark_processed sets the \\Seen flag via UID STORE."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)

    fetcher = _make_fetcher()
    fetcher.mark_processed("12345")

    inst = fake_imap_factory.instances[0]
    assert len(inst.store_calls) == 1
    uid_arg, flags_arg, value_arg = inst.store_calls[0]
    assert uid_arg == b"12345"
    assert flags_arg == "+FLAGS"
    assert "Seen" in value_arg


def test_mark_processed_idempotent(fake_imap_factory, imap_creds, monkeypatch, tmp_path):
    """mark_processed can be called multiple times without error (idempotent)."""
    monkeypatch.setattr("finance_pipeline.emails.fetchers.imap.RAW_EMAIL", tmp_path)

    fetcher = _make_fetcher()
    fetcher.mark_processed("42")
    fetcher.mark_processed("42")

    # Two STORE calls, both for the same UID — no exception
    inst = fake_imap_factory.instances[0]
    assert len(inst.store_calls) == 2
