"""positions identity layer — get-or-create per (account, chain, contract,
symbol), idempotent snapshots, source-priority resolution semantics."""

from __future__ import annotations

from finance_pipeline import positions


def test_upsert_position_same_identity_returns_same_id(conn, seed_account):
    seed_account("a")
    pid_a = positions.upsert_position(
        conn, account_id="a", symbol="ETH",
        chain="base", contract_address="0xABC",
    )
    pid_b = positions.upsert_position(
        conn, account_id="a", symbol="ETH",
        chain="base", contract_address="0xabc",  # case insensitive
    )
    assert pid_a == pid_b
    n = conn.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
    assert n == 1


def test_upsert_position_different_chain_creates_new(conn, seed_account):
    """Same symbol+contract on a different chain is a different position."""
    seed_account("a")
    p1 = positions.upsert_position(
        conn, account_id="a", symbol="USDC",
        chain="ethereum", contract_address="0xabc",
    )
    p2 = positions.upsert_position(
        conn, account_id="a", symbol="USDC",
        chain="base", contract_address="0xabc",
    )
    assert p1 != p2


def test_upsert_position_off_chain_keys_by_symbol_only(conn, seed_account):
    """Off-chain (no chain, no contract) — distinguished by symbol only."""
    seed_account("a")
    p_eth = positions.upsert_position(conn, account_id="a", symbol="VTSAX")
    p_eth2 = positions.upsert_position(conn, account_id="a", symbol="VTSAX")
    p_other = positions.upsert_position(conn, account_id="a", symbol="VTIAX")
    assert p_eth == p_eth2
    assert p_eth != p_other


def test_record_snapshot_idempotent(conn, seed_account):
    """Re-recording the same (position, date, source) updates value."""
    seed_account("a")
    pid = positions.upsert_position(conn, account_id="a", symbol="ETH")
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-01-01",
        source="zerion", value_usd=1000.0, quantity=0.5,
    )
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-01-01",
        source="zerion", value_usd=1100.0, quantity=0.5,
    )
    rows = conn.execute(
        "SELECT value_usd FROM position_snapshots WHERE position_id = ?",
        (pid,),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 1100.0


def test_record_snapshot_distinct_sources_coexist(conn, seed_account):
    """Two sources on the same date keep both readings (source-priority
    is resolved at query time, not write time)."""
    seed_account("a")
    pid = positions.upsert_position(conn, account_id="a", symbol="ETH")
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-01-01",
        source="zerion", value_usd=1000.0,
    )
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-01-01",
        source="kubera", value_usd=1100.0,
    )
    rows = conn.execute(
        "SELECT source, value_usd FROM position_snapshots "
        "WHERE position_id = ? ORDER BY source",
        (pid,),
    ).fetchall()
    assert [(r[0], r[1]) for r in rows] == [
        ("kubera", 1100.0),
        ("zerion", 1000.0),
    ]


def test_upsert_holding_full_path(conn, seed_account):
    """The convenience wrapper creates position + snapshot in one call."""
    seed_account("a")
    positions.upsert_holding(
        conn,
        account_id="a", symbol="WETH",
        as_of="2025-01-01", source="zerion",
        value_usd=2000.0,
        chain="base", contract_address="0xDEF",
        quantity=0.95,
        asset_class="crypto",
    )
    pos = conn.execute(
        "SELECT chain, contract_address, asset_class FROM positions"
    ).fetchone()
    assert pos[0] == "base"
    assert pos[1] == "0xdef"  # lowercased on store
    assert pos[2] == "crypto"
    snap = conn.execute(
        "SELECT source, value_usd, quantity FROM position_snapshots"
    ).fetchone()
    assert (snap[0], snap[1], snap[2]) == ("zerion", 2000.0, 0.95)


def test_holdings_trust_order_constants():
    """Trust order list is non-empty and dedup'd; ranks are unique."""
    assert positions.HOLDINGS_TRUST_ORDER, "trust order must be non-empty"
    ranks = list(positions.HOLDINGS_TRUST_RANK.values())
    assert len(ranks) == len(set(ranks)), "ranks must be unique"
    # Source-of-record beats backfills.
    assert (
        positions.HOLDINGS_TRUST_RANK["simplefin"]
        < positions.HOLDINGS_TRUST_RANK["backfill:yfinance"]
    )
    assert (
        positions.HOLDINGS_TRUST_RANK["zerion"]
        < positions.HOLDINGS_TRUST_RANK["backfill:zerion-fungible"]
    )
