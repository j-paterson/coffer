"""Tests for zerion parser's account-archive helper.

clear_zero_value_manual archives a manual account whose latest
balance_assertion is missing or under $1.
"""
from __future__ import annotations

from contextlib import contextmanager

from finance_pipeline.parsers import zerion


@contextmanager
def _ctx(c):
    yield c


def _patch_connect(monkeypatch, conn):
    # Strip pre-seeded equity equity:* manual accounts from migration 021
    # so test assertions aren't muddied by their archival.
    conn.execute("DELETE FROM accounts WHERE id LIKE 'equity:%'")
    monkeypatch.setattr(
        zerion, "connect", lambda *a, **kw: _ctx(conn)
    )


def test_clear_zero_value_manual_keeps_accounts_with_assertion(monkeypatch, conn, seed_account):
    """A manual account with a non-zero balance_assertion stays active."""
    seed_account("manual:house", mode="manual", type="alt")
    conn.execute(
        "INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) "
        "VALUES ('manual:house', '2025-01-01', 500000.0, 'manual')"
    )
    _patch_connect(monkeypatch, conn)

    archived = zerion.clear_zero_value_manual()

    assert archived == 0
    row = conn.execute("SELECT active FROM accounts WHERE id = 'manual:house'").fetchone()
    assert row["active"] == 1


def test_clear_zero_value_manual_archives_fully_empty(monkeypatch, conn, seed_account):
    """No assertion → archive."""
    seed_account("manual:dead", mode="manual")
    _patch_connect(monkeypatch, conn)

    archived = zerion.clear_zero_value_manual()

    assert archived == 1
    row = conn.execute("SELECT active FROM accounts WHERE id = 'manual:dead'").fetchone()
    assert row["active"] == 0


def test_clear_zero_value_manual_archives_zero_assertion(monkeypatch, conn, seed_account):
    """Latest assertion is 0 → archive."""
    seed_account("manual:zero", mode="manual")
    conn.execute(
        "INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) "
        "VALUES ('manual:zero', '2025-01-01', 0.0, 'manual')"
    )
    _patch_connect(monkeypatch, conn)

    assert zerion.clear_zero_value_manual() == 1


def test_clear_zero_value_manual_ignores_live_accounts(monkeypatch, conn, seed_account):
    """mode='live' must never be touched, even if balance is zero."""
    seed_account("live:bank", mode="live")
    _patch_connect(monkeypatch, conn)

    archived = zerion.clear_zero_value_manual()

    assert archived == 0
    row = conn.execute("SELECT active FROM accounts WHERE id = 'live:bank'").fetchone()
    assert row["active"] == 1


def test_sync_emits_per_chain_events(monkeypatch, conn):
    """zerion.sync() emits sync_started, one account_started/finished
    per (wallet, chain) account_id, and sync_finished, in that order."""
    import json
    import os
    from finance_pipeline import events
    from finance_pipeline.parsers import zerion

    # Patch zerion's `connect` to yield the in-memory conn.
    _patch_connect(monkeypatch, conn)

    # Stub the per-wallet HTTP layer + wallet discovery.
    monkeypatch.setattr(
        zerion, "get_wallets",
        lambda: ["0xABCDEF0000000000000000000000000000000001"],
    )
    monkeypatch.setattr(
        zerion, "_fetch_positions",
        lambda addr: {
            "data": [
                {"attributes": {
                    "fungible_info": {"symbol": "ETH", "implementations": [{"chain_id": "ethereum", "address": ""}]},
                    "quantity": {"float": 1.0}, "value": 3000.0,
                 }, "relationships": {"chain": {"data": {"id": "ethereum"}}}},
                {"attributes": {
                    "fungible_info": {"symbol": "MATIC", "implementations": [{"chain_id": "polygon", "address": ""}]},
                    "quantity": {"float": 100.0}, "value": 80.0,
                 }, "relationships": {"chain": {"data": {"id": "polygon"}}}},
            ]
        },
    )

    # Quiet the post-loop machinery — none of it is in scope for this test.
    monkeypatch.setattr(zerion, "_fetch_chart", lambda addr, period, chain: {"data": {"attributes": {"points": []}}})
    monkeypatch.setattr(zerion, "_cache_hit", lambda source, subject, hours: True)
    monkeypatch.setattr(zerion, "reconcile_evm_by_name", lambda: 0)
    monkeypatch.setattr(zerion, "clear_zero_value_manual", lambda: 0)
    monkeypatch.setattr("finance_pipeline.parsers.zerion.time.sleep", lambda *a, **k: None)

    r, w = os.pipe()
    events.init(w)
    try:
        zerion.sync()
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

    expected = {
        "zerion:ethereum:0xABCDEF0000000000000000000000000000000001",
        "zerion:polygon:0xABCDEF0000000000000000000000000000000001",
    }
    started = {e["account_id"] for e in lines if e["type"] == "account_started"}
    finished = {e["account_id"] for e in lines if e["type"] == "account_finished"}
    assert started == expected
    assert finished == expected

    # account_started for a given account_id must precede its finished pair.
    for aid in expected:
        s_idx = next(i for i, e in enumerate(lines) if e.get("type") == "account_started" and e.get("account_id") == aid)
        f_idx = next(i for i, e in enumerate(lines) if e.get("type") == "account_finished" and e.get("account_id") == aid)
        assert s_idx < f_idx

    assert lines[-1]["ok"] is True


def test_sync_emits_sync_finished_when_no_wallets(monkeypatch, conn):
    """Early-return path (no wallets configured) must still emit
    sync_finished so the UI doesn't stall."""
    import json
    import os
    from finance_pipeline import events
    from finance_pipeline.parsers import zerion

    _patch_connect(monkeypatch, conn)
    monkeypatch.setattr(zerion, "get_wallets", lambda: [])

    r, w = os.pipe()
    events.init(w)
    try:
        zerion.sync()
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
    assert len(lines) == 2          # exactly sync_started + sync_finished, nothing else
    assert lines[-1]["ok"] is True  # early-return is a successful no-op


def test_sync_emits_account_finished_false_on_per_chain_error(monkeypatch, conn):
    """If a DB write fails mid-chain, account_finished(ok=False) must still
    be emitted to pair the account_started, and sync_finished(ok=False) must
    close the run."""
    import json
    import os
    import pytest
    from finance_pipeline import events
    from finance_pipeline.parsers import zerion

    _patch_connect(monkeypatch, conn)

    monkeypatch.setattr(
        zerion, "get_wallets",
        lambda: ["0xABCDEF0000000000000000000000000000000001"],
    )
    monkeypatch.setattr(
        zerion, "_fetch_positions",
        lambda addr: {
            "data": [
                {"attributes": {
                    "fungible_info": {"symbol": "ETH", "implementations": [{"chain_id": "ethereum", "address": ""}]},
                    "quantity": {"float": 1.0}, "value": 3000.0,
                 }, "relationships": {"chain": {"data": {"id": "ethereum"}}}},
            ]
        },
    )

    monkeypatch.setattr(zerion, "_fetch_chart", lambda addr, period, chain: {"data": {"attributes": {"points": []}}})
    monkeypatch.setattr(zerion, "_cache_hit", lambda source, subject, hours: True)
    monkeypatch.setattr(zerion, "reconcile_evm_by_name", lambda: 0)
    monkeypatch.setattr(zerion, "clear_zero_value_manual", lambda: 0)
    monkeypatch.setattr("finance_pipeline.parsers.zerion.time.sleep", lambda *a, **k: None)

    monkeypatch.setattr(zerion, "_upsert_account", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("simulated db failure")))

    r, w = os.pipe()
    events.init(w)
    try:
        with pytest.raises(RuntimeError, match="simulated db failure"):
            zerion.sync()
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

    account_id = "zerion:ethereum:0xABCDEF0000000000000000000000000000000001"

    started_events = [e for e in lines if e["type"] == "account_started" and e.get("account_id") == account_id]
    finished_events = [e for e in lines if e["type"] == "account_finished" and e.get("account_id") == account_id]

    assert len(started_events) == 1, "expected exactly one account_started for failing account"
    assert len(finished_events) == 1, "expected exactly one account_finished for failing account"
    assert finished_events[0]["ok"] is False, "account_finished must have ok=False on error"

    assert lines[-1]["type"] == "sync_finished"
    assert lines[-1]["ok"] is False
