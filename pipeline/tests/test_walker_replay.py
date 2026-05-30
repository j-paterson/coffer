"""Offline-replay paths for the alchemy + coinbase walkers.

Both walkers cache their raw API payloads to `raw_events` before deriving
position_snapshots. The replay() entry points re-derive snapshots from
that cache without hitting the network — useful after a price backfill
or a snapshot-writing logic change.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager

import pytest

from finance_pipeline import backfill_alchemy_history
from finance_pipeline.parsers import coinbase_direct


@contextmanager
def _ctx(c):
    yield c


def _seed_alchemy_cache(
    conn: sqlite3.Connection,
    chain: str,
    addr: str,
    transfers: list[dict],
) -> None:
    """Insert a list of Alchemy transfers into raw_events under the same
    external_id shape the live walker emits."""
    for t in transfers:
        tx_hash = t.get("hash") or ""
        tx_idx = t.get("uniqueId") or ""
        direction = t.get("_direction", "")
        ext_id = (
            f"alchemy-transfer:{chain}:{addr.lower()}:"
            f"{tx_hash}:{tx_idx}:{direction}"
        )
        conn.execute(
            """
            INSERT INTO raw_events (source, source_file, external_id, payload)
            VALUES ('alchemy-history', NULL, ?, ?)
            """,
            (ext_id, json.dumps(t)),
        )


def test_alchemy_replay_writes_snapshots_from_cached_transfers(
    monkeypatch, conn, seed_account
):
    """A wallet with two cached transfers gets the same qty-walk +
    snapshot output it would get from a live fetch."""
    addr = "0x000000000000000000000000000000000000beef"
    contract = "0x0000000000000000000000000000000000000aaa"
    acct_id = seed_account(
        f"zerion:ethereum:{addr}", display_name="Test Wallet", type="crypto",
    )
    # Daily prices for the test contract.
    for d, px in [
        ("2026-04-10", 100.0),
        ("2026-04-11", 110.0),
        ("2026-04-12", 120.0),
    ]:
        conn.execute(
            """
            INSERT INTO asset_prices
              (symbol, source, as_of, price_usd, chain, contract_address)
            VALUES ('TEST', 'defillama', ?, ?, 'ethereum', ?)
            """,
            (d, px, contract),
        )

    _seed_alchemy_cache(conn, "ethereum", addr, [
        {
            "hash": "0xabc1",
            "uniqueId": "1",
            "_direction": "toAddress",
            "from": "0x1111111111111111111111111111111111111111",
            "to": addr,
            "asset": "TEST",
            "category": "erc20",
            "value": 5.0,
            "rawContract": {"address": contract},
            "metadata": {"blockTimestamp": "2026-04-10T12:00:00Z"},
        },
        {
            "hash": "0xabc2",
            "uniqueId": "2",
            "_direction": "fromAddress",
            "from": addr,
            "to": "0x2222222222222222222222222222222222222222",
            "asset": "TEST",
            "category": "erc20",
            "value": 2.0,
            "rawContract": {"address": contract},
            "metadata": {"blockTimestamp": "2026-04-12T12:00:00Z"},
        },
    ])

    monkeypatch.setattr(
        backfill_alchemy_history.db, "connect", lambda *a, **kw: _ctx(conn),
    )

    stats = backfill_alchemy_history.replay()

    assert stats.wallets == 1
    assert stats.transfers_pulled == 2
    snapshots = conn.execute(
        """
        SELECT ps.as_of, ps.quantity, ps.value_usd
        FROM position_snapshots ps
        JOIN positions p ON p.id = ps.position_id
        WHERE p.account_id = ? AND ps.source = 'alchemy-history'
        ORDER BY ps.as_of
        """,
        (acct_id,),
    ).fetchall()
    by_date = {r[0]: (r[1], r[2]) for r in snapshots}
    # +5 on the 10th, -2 on the 12th → balance: 5, 5, 3.
    assert by_date["2026-04-10"][0] == pytest.approx(5.0)
    assert by_date["2026-04-10"][1] == pytest.approx(500.0)
    assert by_date["2026-04-11"][0] == pytest.approx(5.0)
    assert by_date["2026-04-11"][1] == pytest.approx(550.0)
    assert by_date["2026-04-12"][0] == pytest.approx(3.0)
    assert by_date["2026-04-12"][1] == pytest.approx(360.0)


def test_alchemy_replay_skips_wallets_without_active_account(
    monkeypatch, conn
):
    """Cached transfers for a wallet with no `accounts` row are skipped
    rather than written under a phantom account_id."""
    addr = "0x000000000000000000000000000000000000dead"
    _seed_alchemy_cache(conn, "ethereum", addr, [
        {
            "hash": "0xabc",
            "uniqueId": "1",
            "_direction": "toAddress",
            "from": "0x1111111111111111111111111111111111111111",
            "to": addr,
            "asset": "TEST",
            "category": "erc20",
            "value": 1.0,
            "rawContract": {"address": "0xaaa"},
            "metadata": {"blockTimestamp": "2026-04-10T00:00:00Z"},
        },
    ])
    monkeypatch.setattr(
        backfill_alchemy_history.db, "connect", lambda *a, **kw: _ctx(conn),
    )

    stats = backfill_alchemy_history.replay()

    assert stats.wallets == 0
    snapshots = conn.execute(
        "SELECT COUNT(*) FROM position_snapshots WHERE source = 'alchemy-history'"
    ).fetchone()[0]
    positions_count = conn.execute(
        "SELECT COUNT(*) FROM positions"
    ).fetchone()[0]
    assert positions_count == 0
    assert snapshots == 0


def _seed_coinbase_cache(
    conn: sqlite3.Connection,
    cb_uuid: str,
    cb_name: str,
    currency: str,
    qty_today: float,
    v2_uuid: str,
    txns: list[dict],
    today: str = "2026-04-30",
) -> None:
    """Cache one Coinbase account + its v2 txn list under the external_id
    shapes the live walker emits."""
    conn.execute(
        """
        INSERT INTO raw_events (source, source_file, external_id, payload)
        VALUES ('coinbase-direct', NULL, ?, ?)
        """,
        (
            f"coinbase-v3-account:{cb_uuid}:{today}",
            json.dumps({
                "uuid": cb_uuid,
                "name": cb_name,
                "currency": currency,
                "available_balance": {"value": str(qty_today), "currency": currency},
            }),
        ),
    )
    conn.execute(
        """
        INSERT INTO raw_events (source, source_file, external_id, payload)
        VALUES ('coinbase-direct', NULL, ?, ?)
        """,
        (
            f"coinbase-v2-account:{v2_uuid}:{today}",
            json.dumps({"id": v2_uuid, "name": cb_name}),
        ),
    )
    for t in txns:
        conn.execute(
            """
            INSERT INTO raw_events (source, source_file, external_id, payload)
            VALUES ('coinbase-direct', NULL, ?, ?)
            """,
            (
                f"coinbase-v2-txn:{v2_uuid}:{t['id']}",
                json.dumps(t),
            ),
        )


def test_coinbase_replay_writes_snapshots_from_cached_payloads(
    monkeypatch, conn, seed_account
):
    """Cached v2 + v3 account snapshots + cached v2 txns produce the same
    snapshot series the live sync would write."""
    canonical = seed_account(
        "simplefin:ACT-eth", display_name="ETH Wallet", type="crypto",
        institution="Coinbase",
    )
    for d, px in [
        ("2026-04-10", 3000.0),
        ("2026-04-12", 3200.0),
    ]:
        conn.execute(
            """
            INSERT INTO asset_prices (symbol, source, as_of, price_usd)
            VALUES ('ETH', 'defillama', ?, ?)
            """,
            (d, px),
        )

    _seed_coinbase_cache(
        conn,
        cb_uuid="cb-uuid-eth",
        cb_name="ETH Wallet",
        currency="ETH",
        qty_today=0.5,
        v2_uuid="v2-eth",
        txns=[
            {
                "id": "txn1",
                "status": "completed",
                "created_at": "2026-04-10T08:00:00Z",
                "amount": {"amount": "1.0", "currency": "ETH"},
            },
            {
                "id": "txn2",
                "status": "completed",
                "created_at": "2026-04-12T08:00:00Z",
                "amount": {"amount": "-0.5", "currency": "ETH"},
            },
        ],
    )

    monkeypatch.setattr(
        coinbase_direct.db, "connect", lambda *a, **kw: _ctx(conn),
    )

    stats = coinbase_direct.replay()

    assert stats.accounts_visible == 1
    assert stats.accounts_mapped == 1
    assert stats.txns_pulled == 2
    snaps = conn.execute(
        """
        SELECT ps.as_of, ps.quantity
        FROM position_snapshots ps
        JOIN positions p ON p.id = ps.position_id
        WHERE p.account_id = ? AND ps.source = 'coinbase-direct' AND p.symbol = 'ETH'
        ORDER BY ps.as_of
        """,
        (canonical,),
    ).fetchall()
    by_date = {r[0]: r[1] for r in snaps}
    # +1 on 4/10, -0.5 on 4/12. Forward-fill capped at last delta date,
    # so we expect exactly the dates with prices ≤ last delta.
    assert by_date["2026-04-10"] == pytest.approx(1.0)
    assert by_date["2026-04-12"] == pytest.approx(0.5)


def test_coinbase_replay_takes_latest_account_snapshot(
    monkeypatch, conn, seed_account
):
    """When raw_events has multiple cached snapshots for the same
    account on different dates, replay uses the most recent one."""
    canonical = seed_account(
        "simplefin:ACT-eth", display_name="ETH Wallet", type="crypto",
        institution="Coinbase",
    )
    conn.execute(
        """
        INSERT INTO asset_prices (symbol, source, as_of, price_usd)
        VALUES ('ETH', 'defillama', '2026-04-30', 3000.0)
        """,
    )
    # Older snapshot reports stale balance.
    conn.execute(
        """
        INSERT INTO raw_events (source, source_file, external_id, payload)
        VALUES ('coinbase-direct', NULL,
          'coinbase-v3-account:cb-uuid-eth:2026-04-20',
          ?)
        """,
        (json.dumps({
            "uuid": "cb-uuid-eth", "name": "ETH Wallet", "currency": "ETH",
            "available_balance": {"value": "9.0", "currency": "ETH"},
        }),),
    )
    # Newer snapshot reports current balance.
    conn.execute(
        """
        INSERT INTO raw_events (source, source_file, external_id, payload)
        VALUES ('coinbase-direct', NULL,
          'coinbase-v3-account:cb-uuid-eth:2026-04-30',
          ?)
        """,
        (json.dumps({
            "uuid": "cb-uuid-eth", "name": "ETH Wallet", "currency": "ETH",
            "available_balance": {"value": "1.5", "currency": "ETH"},
        }),),
    )
    conn.execute(
        """
        INSERT INTO raw_events (source, source_file, external_id, payload)
        VALUES ('coinbase-direct', NULL,
          'coinbase-v2-account:v2-eth:2026-04-30',
          '{"id":"v2-eth","name":"ETH Wallet"}')
        """,
    )

    monkeypatch.setattr(
        coinbase_direct.db, "connect", lambda *a, **kw: _ctx(conn),
    )

    stats = coinbase_direct.replay()

    assert stats.accounts_visible == 1
    # Today's snapshot should reflect the newer balance (1.5 * 3000 = 4500).
    snap = conn.execute(
        """
        SELECT ps.quantity, ps.value_usd
        FROM position_snapshots ps
        JOIN positions p ON p.id = ps.position_id
        WHERE p.account_id = ? AND ps.source = 'coinbase-direct'
          AND p.symbol = 'ETH' AND ps.as_of = '2026-04-30'
        """,
        (canonical,),
    ).fetchone()
    assert snap is not None
    assert snap[0] == pytest.approx(1.5)
    assert snap[1] == pytest.approx(4500.0)
