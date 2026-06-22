import json
import os
import pytest
from finance_pipeline import events


def test_emit_is_noop_when_not_initialized():
    events.init(None)
    events.sync_started(run_id="r1", sources=["simplefin"])
    # Nothing to assert — the call should not raise.


def test_emit_writes_one_json_line_per_call():
    r, w = os.pipe()
    events.init(w)
    events.sync_started(run_id="r1", sources=["simplefin"])
    events.account_started(account_id="ACT-1", source="simplefin")
    events.account_finished(account_id="ACT-1", ok=True)
    events.sync_finished(run_id="r1", ok=True, totals={"accounts": 1})
    events.close()

    raw = os.read(r, 4096).decode()
    os.close(r)

    lines = [ln for ln in raw.split("\n") if ln]
    assert len(lines) == 4
    assert json.loads(lines[0]) == {
        "type": "sync_started", "run_id": "r1", "sources": ["simplefin"]
    }
    assert json.loads(lines[1]) == {
        "type": "account_started", "account_id": "ACT-1", "source": "simplefin"
    }
    assert json.loads(lines[2]) == {
        "type": "account_finished", "account_id": "ACT-1", "ok": True
    }
    assert json.loads(lines[3]) == {
        "type": "sync_finished", "run_id": "r1", "ok": True, "totals": {"accounts": 1}
    }


def test_account_log_carries_message_and_default_level():
    r, w = os.pipe()
    events.init(w)
    events.account_log(account_id="ACT-1", message="wrote 5 postings")
    events.close()
    raw = os.read(r, 4096).decode()
    os.close(r)
    [line] = [ln for ln in raw.split("\n") if ln]
    assert json.loads(line) == {
        "type": "account_log",
        "account_id": "ACT-1",
        "message": "wrote 5 postings",
        "level": "info",
    }


def test_warning_event_with_global_scope():
    r, w = os.pipe()
    events.init(w)
    events.warning(account_id=None, message="rate limited")
    events.close()
    raw = os.read(r, 4096).decode()
    os.close(r)
    [line] = [ln for ln in raw.split("\n") if ln]
    assert json.loads(line) == {
        "type": "warning",
        "account_id": None,
        "message": "rate limited",
    }


def test_cli_sync_initializes_events_when_fd_passed(monkeypatch):
    """Running the CLI with --events-fd N must call events.init(N)."""
    from finance_pipeline import cli, events

    init_calls: list[int | None] = []
    monkeypatch.setattr(events, "init", lambda fd: init_calls.append(fd))
    # Stub the actual sync to avoid hitting the network / DB.
    monkeypatch.setattr(
        "finance_pipeline.ingest.sync_simplefin",
        lambda **kw: type("WC", (), {"as_dict": lambda self: {}})()
    )
    monkeypatch.setattr(cli, "_post_write_reconcile", lambda: None)
    monkeypatch.setattr(cli, "_post_brokerage_sync", lambda: None)

    rc = cli.main(["sync", "simplefin", "--days", "30", "--events-fd", "7"])
    assert rc == 0
    assert init_calls == [7]


def test_cli_sync_initializes_none_when_fd_omitted(monkeypatch):
    from finance_pipeline import cli, events

    init_calls: list[int | None] = []
    monkeypatch.setattr(events, "init", lambda fd: init_calls.append(fd))
    monkeypatch.setattr(
        "finance_pipeline.ingest.sync_simplefin",
        lambda **kw: type("WC", (), {"as_dict": lambda self: {}})()
    )
    monkeypatch.setattr(cli, "_post_write_reconcile", lambda: None)
    monkeypatch.setattr(cli, "_post_brokerage_sync", lambda: None)

    rc = cli.main(["sync", "simplefin", "--days", "30"])
    assert rc == 0
    assert init_calls == [None]


def test_cli_sync_all_runs_sources_in_sequence(monkeypatch):
    """`finance sync all` invokes simplefin and zerion in sequence,
    emits a single bracketing sync_started/sync_finished, and runs
    alchemy fallback when zerion produces 0 accounts."""
    import os
    import json
    from finance_pipeline import cli, events

    r, w = os.pipe()

    calls: list[str] = []
    monkeypatch.setattr(
        "finance_pipeline.ingest.sync_simplefin",
        lambda **kw: (calls.append("simplefin"), type("WC", (), {"as_dict": lambda self: {}, "accounts": 1})())[1],
    )
    monkeypatch.setattr(
        "finance_pipeline.parsers.zerion.sync",
        lambda **kw: (calls.append("zerion"), type("ZS", (), {"errors": 0, "wallets": 1, "accounts": 0})())[1],
    )
    monkeypatch.setattr(
        "finance_pipeline.parsers.alchemy.sync",
        lambda **kw: (calls.append("alchemy"), type("AS", (), {"errors": 0})())[1],
    )
    monkeypatch.setattr(cli, "_post_write_reconcile", lambda: None)
    monkeypatch.setattr(cli, "_post_brokerage_sync", lambda: None)
    monkeypatch.setattr(cli, "_post_crypto_sync", lambda: None)

    rc = cli.main(["sync", "all", "--events-fd", str(w)])
    events.close()
    assert rc == 0
    # Zerion returned 0 accounts → alchemy fallback ran.
    assert calls == ["simplefin", "zerion", "alchemy"]

    chunks: list[bytes] = []
    while True:
        chunk = os.read(r, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(r)
    raw = b"".join(chunks).decode()
    types = [json.loads(ln)["type"] for ln in raw.split("\n") if ln]
    assert types.count("sync_started") == 1
    assert types.count("sync_finished") == 1
    assert types[0] == "sync_started"
    assert types[-1] == "sync_finished"


def test_cli_sync_all_emits_sync_finished_on_source_exception(monkeypatch):
    """`finance sync all` must emit sync_finished even when a source raises."""
    import os
    import json
    from finance_pipeline import cli, events

    r, w = os.pipe()

    alchemy_calls: list[str] = []
    monkeypatch.setattr(
        "finance_pipeline.ingest.sync_simplefin",
        lambda **kw: type("WC", (), {"as_dict": lambda self: {}, "accounts": 1})(),
    )
    monkeypatch.setattr(
        "finance_pipeline.parsers.zerion.sync",
        lambda **kw: (_ for _ in ()).throw(RuntimeError("simulated zerion failure")),
    )
    monkeypatch.setattr(
        "finance_pipeline.parsers.alchemy.sync",
        lambda **kw: (alchemy_calls.append("alchemy"), type("AS", (), {"errors": 0})())[1],
    )
    monkeypatch.setattr(cli, "_post_write_reconcile", lambda: None)
    monkeypatch.setattr(cli, "_post_brokerage_sync", lambda: None)
    monkeypatch.setattr(cli, "_post_crypto_sync", lambda: None)

    with pytest.raises(RuntimeError, match="simulated zerion failure"):
        cli.main(["sync", "all", "--events-fd", str(w)])
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

    assert lines[0]["type"] == "sync_started"
    assert lines[-1]["type"] == "sync_finished"
    assert lines[-1]["ok"] is False
    # Alchemy fallback must NOT have been called — zerion raised before reaching it.
    assert alchemy_calls == []
