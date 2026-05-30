"""SimpleFIN parse() smoke test.

parse() is the pure mapping step from a SimpleFIN /accounts response to
our row dataclasses. The live sync pipeline reads rows out of this
result and writes them into the DB — if the shape breaks, every sync
from here quietly drops data.
"""
from __future__ import annotations

from finance_pipeline.parsers import simplefin


SAMPLE_RESPONSE = {
    "errors": [],
    "accounts": [
        {
            "id": "abc-123",
            "name": "Freedom Unlimited",
            "currency": "USD",
            "balance": "1234.56",
            "org": {"name": "Chase", "domain": "chase.com"},
            "transactions": [
                {
                    "id": "t1",
                    "posted": 1735689600,  # 2025-01-01 UTC
                    "amount": "-42.00",
                    "description": "STARBUCKS 123 SEATTLE WA",
                    "payee": "Starbucks",
                },
                {
                    "id": "t2",
                    "posted": 1735776000,
                    "amount": "1000.00",
                    "description": "PAYMENT THANK YOU",
                    "pending": True,
                },
            ],
        },
        {
            "id": "def-456",
            "name": "Rewards Checking",
            "balance": "50",
            "org": {"domain": "randombank.com"},
        },
    ],
}


def test_parse_yields_one_account_and_balance_per_entry():
    r = simplefin.parse(SAMPLE_RESPONSE, as_of="2025-01-01")
    assert len(r.accounts) == 2
    assert len(r.balances) == 2
    ids = {a.id for a in r.accounts}
    assert ids == {"simplefin:abc-123", "simplefin:def-456"}


def test_parse_preserves_institution_and_currency():
    r = simplefin.parse(SAMPLE_RESPONSE, as_of="2025-01-01")
    by_id = {a.id: a for a in r.accounts}
    assert by_id["simplefin:abc-123"].institution == "Chase"
    assert by_id["simplefin:abc-123"].currency == "USD"
    # Falls back to domain when name is missing.
    assert by_id["simplefin:def-456"].institution == "randombank.com"


def test_parse_balances_are_signed_float():
    r = simplefin.parse(SAMPLE_RESPONSE, as_of="2025-01-01")
    by_acct = {b.account_id: b for b in r.balances}
    assert by_acct["simplefin:abc-123"].value_usd == 1234.56
    assert by_acct["simplefin:abc-123"].source == "simplefin"
    assert by_acct["simplefin:abc-123"].as_of == "2025-01-01"


def test_parse_transactions_carry_composite_id_and_pending_tag():
    r = simplefin.parse(SAMPLE_RESPONSE, as_of="2025-01-01")
    txns = [t for t in r.transactions if t.account_id == "simplefin:abc-123"]
    assert len(txns) == 2
    by_id = {t.id: t for t in txns}
    assert "sf:abc-123:t1" in by_id
    assert by_id["sf:abc-123:t1"].amount == -42.0
    assert by_id["sf:abc-123:t1"].payee == "Starbucks"
    assert by_id["sf:abc-123:t2"].tags == "pending"
    assert by_id["sf:abc-123:t1"].tags is None


def test_parse_skips_txn_with_no_date():
    data = {
        "accounts": [
            {
                "id": "x",
                "name": "X",
                "balance": "0",
                "org": {"name": "Y"},
                "transactions": [{"id": "nodate", "amount": "1"}],
            }
        ]
    }
    r = simplefin.parse(data, as_of="2025-01-01")
    assert len(r.transactions) == 0
    assert any("no date" in w for w in r.warnings)


def test_parse_skips_account_with_no_id():
    data = {"accounts": [{"name": "Anonymous", "balance": "100"}]}
    r = simplefin.parse(data, as_of="2025-01-01")
    assert r.accounts == []
    assert r.balances == []


def test_sync_simplefin_emits_per_account_events(monkeypatch, tmp_path):
    """sync_simplefin must emit sync_started + account_started/finished
    per account + sync_finished, in order, when events fd is initialized."""
    import json
    import os
    from finance_pipeline import events, ingest
    from finance_pipeline import db as _db

    # Redirect db.connect()/migrate() to a temp DB by overriding their
    # captured-at-import-time DB_PATH defaults.
    # db.connect is wrapped by @contextmanager so the default lives on __wrapped__.
    test_db = tmp_path / "test.db"
    monkeypatch.setattr(_db.connect.__wrapped__, "__defaults__", (test_db,))
    monkeypatch.setattr(_db.migrate, "__defaults__", (test_db, _db.migrate.__defaults__[1]))
    _db.migrate(db_path=test_db)

    # load_env() reads from a .env file; stub it directly.
    monkeypatch.setattr(
        "finance_pipeline.ingest.load_env",
        lambda: {"SIMPLEFIN_ACCESS_URL": "https://x:y@example.com/sfin"},
    )

    # Stub the SimpleFIN HTTP layer to return two synthetic accounts.
    fake_payload = {
        "accounts": [
            {"id": "ACT-1", "name": "Checking", "balance": "100.00",
             "currency": "USD", "org": {"name": "Bank"}, "transactions": []},
            {"id": "ACT-2", "name": "Savings", "balance": "200.00",
             "currency": "USD", "org": {"name": "Bank"}, "transactions": []},
        ]
    }
    monkeypatch.setattr(
        "finance_pipeline.parsers.simplefin.fetch_accounts",
        lambda url, start_days=365: fake_payload,
    )

    # Open the events pipe and run the sync.
    r, w = os.pipe()
    events.init(w)
    try:
        ingest.sync_simplefin(start_days=30, force=True)
    finally:
        events.close()

    chunks: list[bytes] = []
    while True:
        chunk = os.read(r, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(r)
    raw = b"".join(chunks).decode()
    lines = [json.loads(ln) for ln in raw.split("\n") if ln]
    types = [e["type"] for e in lines]

    assert types[0] == "sync_started"
    assert types[-1] == "sync_finished"

    started_ids = {e["account_id"] for e in lines if e["type"] == "account_started"}
    finished_ids = {e["account_id"] for e in lines if e["type"] == "account_finished"}
    # Account IDs are prefixed with "simplefin:" by the parser.
    assert started_ids == {"simplefin:ACT-1", "simplefin:ACT-2"}
    assert finished_ids == {"simplefin:ACT-1", "simplefin:ACT-2"}

    # Simpler check: every account_started occurs before any account_finished.
    started_indices = [i for i, t in enumerate(types) if t == "account_started"]
    finished_indices = [i for i, t in enumerate(types) if t == "account_finished"]
    assert max(started_indices) < min(finished_indices)

    # sync_finished payload includes totals.
    last = lines[-1]
    assert "totals" in last
    assert "accounts" in last["totals"]
    assert last["ok"] is True


def test_sync_simplefin_emits_sync_finished_on_quota_skip(monkeypatch, tmp_path):
    """When quota is exhausted and force=False, sync_simplefin must still
    emit sync_finished(ok=False) so the UI doesn't stall."""
    import json
    import os
    from finance_pipeline import events, ingest
    from finance_pipeline import db as _db

    test_db = tmp_path / "test.db"
    monkeypatch.setattr(_db.connect.__wrapped__, "__defaults__", (test_db,))
    _db.migrate(db_path=test_db)

    monkeypatch.setattr(
        "finance_pipeline.ingest.load_env",
        lambda: {"SIMPLEFIN_ACCESS_URL": "https://x:y@example.com/sfin"},
    )

    # Pre-fill the cache so the quota guard fires on a non-forced run.
    # Each row needs a unique subject (UNIQUE constraint on source+subject);
    # we append a counter to produce distinct subjects for the same UTC day.
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _db.connect() as conn:
        for i in range(ingest.SIMPLEFIN_DAILY_QUOTA):
            conn.execute(
                "INSERT INTO provider_cache (source, subject, fetched_at) VALUES (?, ?, ?)",
                ("simplefin:accounts", f"{today}-{i}", today),
            )
        conn.commit()

    r, w = os.pipe()
    events.init(w)
    try:
        ingest.sync_simplefin(start_days=30, force=False)
    finally:
        events.close()

    chunks: list[bytes] = []
    while True:
        chunk = os.read(r, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(r)
    lines = [json.loads(ln) for ln in b"".join(chunks).decode().split("\n") if ln]
    types = [e["type"] for e in lines]

    assert types[0] == "sync_started"
    assert types[-1] == "sync_finished"
    assert lines[-1]["ok"] is False


def test_sync_simplefin_emits_sync_finished_on_exception(monkeypatch, tmp_path):
    """When the parse layer raises, sync_simplefin must still emit
    sync_finished(ok=False) before re-raising."""
    import json
    import os
    import pytest
    from finance_pipeline import events, ingest
    from finance_pipeline import db as _db

    test_db = tmp_path / "test.db"
    monkeypatch.setattr(_db.connect.__wrapped__, "__defaults__", (test_db,))
    _db.migrate(db_path=test_db)

    monkeypatch.setattr(
        "finance_pipeline.ingest.load_env",
        lambda: {"SIMPLEFIN_ACCESS_URL": "https://x:y@example.com/sfin"},
    )

    def boom(*a, **k):
        raise RuntimeError("simulated network failure")

    monkeypatch.setattr(
        "finance_pipeline.parsers.simplefin.fetch_accounts", boom
    )

    r, w = os.pipe()
    events.init(w)
    try:
        with pytest.raises(RuntimeError, match="simulated network failure"):
            ingest.sync_simplefin(start_days=30, force=True)
    finally:
        events.close()

    chunks: list[bytes] = []
    while True:
        chunk = os.read(r, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(r)
    lines = [json.loads(ln) for ln in b"".join(chunks).decode().split("\n") if ln]
    types = [e["type"] for e in lines]

    assert types[0] == "sync_started"
    assert types[-1] == "sync_finished"
    assert lines[-1]["ok"] is False
