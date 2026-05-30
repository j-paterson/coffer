"""Price-series helper sources implicit prices from position_snapshots.

The original code read from the v1 `holdings` table; this verifies the
ported version reads value_usd / quantity from position_snapshots
joined to positions, with the same per-day average semantics."""

from __future__ import annotations

from finance_pipeline import positions
from finance_pipeline.backfill_quantity_walk import _price_series_for_symbol


def test_price_series_uses_position_snapshots_only(conn, seed_account):
    """No holdings rows. Implicit price should still come back from
    position_snapshots."""
    seed_account("zerion:base:0xabc")
    pid = positions.upsert_position(
        conn,
        account_id="zerion:base:0xabc",
        symbol="ETH",
        chain="base",
        contract_address="0xeee",
    )
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-06-01",
        source="zerion", value_usd=2000.0, quantity=1.0,
    )

    series = _price_series_for_symbol(conn, "zerion:base:0xabc", "ETH")
    assert series == {"2025-06-01": 2000.0}


def test_price_series_averages_across_accounts_per_day(conn, seed_account):
    """Two accounts' snapshots on the same day average together — same as
    the holdings query did."""
    seed_account("a")
    seed_account("b")
    pa = positions.upsert_position(conn, account_id="a", symbol="ETH")
    pb = positions.upsert_position(conn, account_id="b", symbol="ETH")
    positions.record_snapshot(
        conn, position_id=pa, as_of="2025-06-01",
        source="zerion", value_usd=2000.0, quantity=1.0,
    )
    positions.record_snapshot(
        conn, position_id=pb, as_of="2025-06-01",
        source="zerion", value_usd=4000.0, quantity=2.0,
    )
    series = _price_series_for_symbol(conn, "a", "ETH")
    # Both rows say 2000/eth — average is 2000.
    assert series == {"2025-06-01": 2000.0}


def test_price_series_skips_zero_quantity_or_value(conn, seed_account):
    """Rows with quantity=0 (zero-out snapshots) or value_usd=0 must be
    excluded — division would explode or give a false price."""
    seed_account("a")
    pid = positions.upsert_position(conn, account_id="a", symbol="ETH")
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-06-01",
        source="zerion", value_usd=0.0, quantity=1.0,
    )
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-06-02",
        source="zerion", value_usd=2000.0, quantity=0.0,
    )
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-06-03",
        source="zerion", value_usd=1500.0, quantity=1.0,
    )
    series = _price_series_for_symbol(conn, "a", "ETH")
    assert series == {"2025-06-03": 1500.0}


def test_explicit_asset_prices_override_implicit(conn, seed_account):
    """asset_prices entries win over the implicit price from
    position_snapshots — this preserves the existing precedence."""
    seed_account("a")
    pid = positions.upsert_position(conn, account_id="a", symbol="ETH")
    positions.record_snapshot(
        conn, position_id=pid, as_of="2025-06-01",
        source="zerion", value_usd=2000.0, quantity=1.0,
    )
    conn.execute(
        """
        INSERT INTO asset_prices (symbol, as_of, price_usd, source)
        VALUES ('ETH', '2025-06-01', 2050.0, 'coingecko')
        """,
    )
    series = _price_series_for_symbol(conn, "a", "ETH")
    assert series["2025-06-01"] == 2050.0
