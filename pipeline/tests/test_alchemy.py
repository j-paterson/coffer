"""Smoke test for alchemy wallet sync.

Pins the v2 write contract: alchemy writes balance_assertions and
positions + position_snapshots. Without these the walker has no history
for alchemy-synced wallets."""
from __future__ import annotations

from contextlib import contextmanager

from finance_pipeline.parsers import alchemy


@contextmanager
def _ctx(c):
    yield c


def _patch_network(monkeypatch, conn):
    monkeypatch.setattr(alchemy, "connect", lambda *a, **kw: _ctx(conn))
    monkeypatch.setattr(alchemy, "_get_wallets", lambda: ["0xDEAD"])
    monkeypatch.setattr(
        alchemy, "fetch_native_balance",
        lambda chain, addr: int(2e18) if chain == "ethereum" else 0,
    )
    monkeypatch.setattr(alchemy, "fetch_token_balances", lambda chain, addr: [])
    monkeypatch.setattr(alchemy, "_native_prices", lambda chains: {"ethereum": 3000.0})


def test_sync_writes_account_row(monkeypatch, conn):
    _patch_network(monkeypatch, conn)

    stats = alchemy.sync()

    assert stats.wallets == 1
    acct_id = "zerion:ethereum:0xDEAD"
    acct = conn.execute(
        "SELECT mode, type, institution FROM accounts WHERE id = ?", (acct_id,)
    ).fetchone()
    assert acct["mode"] == "live"


def test_sync_emits_per_chain_events(monkeypatch, conn):
    """alchemy.sync() emits sync_started, one account_started/finished
    per (wallet, chain) pair with actual positions, and sync_finished."""
    import json
    import os
    from finance_pipeline import events

    _patch_network(monkeypatch, conn)

    r, w = os.pipe()
    events.init(w)
    try:
        alchemy.sync()
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

    # Only ethereum returns non-zero native balance (int(2e18) @ $3000),
    # all other chains return 0 wei and no tokens → no positions → skip.
    expected = {"zerion:ethereum:0xDEAD"}
    started = {e["account_id"] for e in lines if e["type"] == "account_started"}
    finished = {e["account_id"] for e in lines if e["type"] == "account_finished"}
    assert started == expected
    assert finished == expected

    # account_started for each id must precede its account_finished pair.
    for aid in expected:
        s_idx = next(
            i for i, e in enumerate(lines)
            if e.get("type") == "account_started" and e.get("account_id") == aid
        )
        f_idx = next(
            i for i, e in enumerate(lines)
            if e.get("type") == "account_finished" and e.get("account_id") == aid
        )
        assert s_idx < f_idx

    assert lines[-1]["ok"] is True


def test_sync_emits_sync_finished_when_no_wallets(monkeypatch, conn):
    """Early-return path (no wallets configured) must still emit
    sync_finished so the UI doesn't stall."""
    import json
    import os
    from finance_pipeline import events

    monkeypatch.setattr(alchemy, "connect", lambda *a, **kw: _ctx(conn))
    monkeypatch.setattr(alchemy, "_get_wallets", lambda: [])

    r, w = os.pipe()
    events.init(w)
    try:
        alchemy.sync()
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

    assert len(lines) == 2
    assert types[0] == "sync_started"
    assert types[-1] == "sync_finished"
    assert lines[-1]["ok"] is True


def test_sync_emits_account_finished_false_on_per_chain_error(monkeypatch, conn):
    """If a DB write fails mid-chain, account_finished(ok=False) must be
    emitted to pair the account_started, and sync_finished(ok=False) must
    close the run."""
    import json
    import os
    import pytest
    from finance_pipeline import events

    _patch_network(monkeypatch, conn)

    monkeypatch.setattr(
        alchemy, "_upsert_account",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("simulated db failure")),
    )

    r, w = os.pipe()
    events.init(w)
    try:
        with pytest.raises(RuntimeError, match="simulated db failure"):
            alchemy.sync()
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

    account_id = "zerion:ethereum:0xDEAD"

    started_events = [
        e for e in lines
        if e["type"] == "account_started" and e.get("account_id") == account_id
    ]
    finished_events = [
        e for e in lines
        if e["type"] == "account_finished" and e.get("account_id") == account_id
    ]

    assert len(started_events) == 1, "expected exactly one account_started for failing account"
    assert len(finished_events) == 1, "expected exactly one account_finished for failing account"
    assert finished_events[0]["ok"] is False, "account_finished must have ok=False on error"

    assert lines[-1]["type"] == "sync_finished"
    assert lines[-1]["ok"] is False


def test_sync_writes_v2_mirror(monkeypatch, conn):
    """balance_assertions + positions + position_snapshots are the
    shape the walker reads. Dropping v1 would break alchemy wallets
    without this mirror in place."""
    _patch_network(monkeypatch, conn)

    alchemy.sync()

    acct = "zerion:ethereum:0xDEAD"
    assertion = conn.execute(
        "SELECT expected_usd, source FROM balance_assertions WHERE account_id = ?",
        (acct,),
    ).fetchone()
    assert assertion is not None
    assert assertion["expected_usd"] == 6000.0
    assert assertion["source"] == "alchemy"

    pos = conn.execute(
        "SELECT id, chain, contract_address FROM positions "
        "WHERE account_id = ? AND symbol = 'ETH'",
        (acct,),
    ).fetchone()
    assert pos is not None
    assert pos["chain"] == "ethereum"
    # Native ETH has no contract address — blank, not null.
    assert pos["contract_address"] == ""

    snap = conn.execute(
        "SELECT quantity, value_usd, source FROM position_snapshots "
        "WHERE position_id = ?",
        (pos["id"],),
    ).fetchone()
    assert snap["quantity"] == 2.0
    assert snap["value_usd"] == 6000.0
    assert snap["source"] == "alchemy"
