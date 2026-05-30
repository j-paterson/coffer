"""CoinTracker EOY tax-lots parser → cost_basis_overrides.

The parser aggregates every open lot for a canonical symbol and writes
a symbol-scoped (account_id = NULL) row in `cost_basis_overrides`. It
must:

  - sum qty + cost across all lots per symbol
  - detect the year from the "Value at YYYY/12/31" column header
  - tolerate the leading-space column names CoinTracker emits
  - preserve manual user-entered overrides (note doesn't start with
    "CoinTracker EOY") on re-runs, and update CT-sourced ones
"""
from __future__ import annotations

import csv
from pathlib import Path

from finance_pipeline.parsers import cointracker_lots


def _write_csv(path: Path, rows: list[dict], year: str = "2025") -> None:
    """Write a CSV in the same format CoinTracker emits — with leading
    spaces on every column except the first."""
    cols = [
        "Asset",
        " Amount",
        " Acquisition Date",
        " Cost Basis (USD)",
        " Wallet Name",
        " Wallet Address",
        f" Value at {year}/12/31 (USD)",
        " Staked/Lent",
    ]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c.strip(), "") for c in cols})


def test_aggregates_lots_per_symbol(tmp_path: Path, conn):
    """Multiple lots for the same symbol get summed into a single
    override row at symbol scope."""
    csv_path = tmp_path / "eoy.csv"
    _write_csv(csv_path, [
        {"Asset": "ETH", "Amount": "1.0", "Acquisition Date": "01/15/2024",
         "Cost Basis (USD)": "2500.00"},
        {"Asset": "ETH", "Amount": "0.5", "Acquisition Date": "06/01/2024",
         "Cost Basis (USD)": "1750.00"},
        {"Asset": "USDC", "Amount": "100.0", "Acquisition Date": "03/01/2024",
         "Cost Basis (USD)": "100.00"},
    ])

    stats = cointracker_lots.parse(csv_path, conn)

    assert stats.year == "2025"
    assert stats.symbols_total == 2
    assert stats.overrides_written == 2

    rows = conn.execute(
        "SELECT symbol, account_id, cost_usd, quantity_at_entry, note "
        "FROM cost_basis_overrides ORDER BY symbol"
    ).fetchall()
    by_sym = {r[0]: r for r in rows}
    assert by_sym["ETH"][1] is None  # account-id-NULL = symbol-scope
    assert by_sym["ETH"][2] == 4250.0
    assert by_sym["ETH"][3] == 1.5
    assert by_sym["ETH"][4] == "CoinTracker EOY 2025-12-31"
    assert by_sym["USDC"][2] == 100.0


def test_preserves_manual_override(tmp_path: Path, conn):
    """A user-entered override (note doesn't start with 'CoinTracker
    EOY') is left alone even if the EOY CSV has the same symbol."""
    conn.execute(
        """
        INSERT INTO cost_basis_overrides
          (symbol, account_id, cost_usd, quantity_at_entry, note)
        VALUES ('SPACE', NULL, 0.0, 7557748109, 'manual: equity grant')
        """
    )
    csv_path = tmp_path / "eoy.csv"
    _write_csv(csv_path, [
        {"Asset": "SPACE", "Amount": "7557748109", "Acquisition Date": "01/01/2024",
         "Cost Basis (USD)": "12345.67"},
    ])

    stats = cointracker_lots.parse(csv_path, conn)

    assert stats.overrides_skipped_manual == 1
    assert stats.overrides_written == 0
    row = conn.execute(
        "SELECT cost_usd, note FROM cost_basis_overrides WHERE symbol = 'SPACE'"
    ).fetchone()
    assert row[0] == 0.0
    assert row[1] == "manual: equity grant"


def test_rerun_updates_ct_sourced_override(tmp_path: Path, conn):
    """Re-running with a fresh EOY CSV updates the prior CT-sourced row
    in place rather than failing the UNIQUE constraint."""
    csv1 = tmp_path / "eoy1.csv"
    _write_csv(csv1, [
        {"Asset": "ETH", "Amount": "1.0", "Acquisition Date": "01/15/2024",
         "Cost Basis (USD)": "2500.00"},
    ], year="2024")
    cointracker_lots.parse(csv1, conn)

    csv2 = tmp_path / "eoy2.csv"
    _write_csv(csv2, [
        {"Asset": "ETH", "Amount": "2.0", "Acquisition Date": "01/15/2024",
         "Cost Basis (USD)": "5000.00"},
    ], year="2025")
    stats = cointracker_lots.parse(csv2, conn)

    assert stats.overrides_written == 1
    rows = conn.execute(
        "SELECT cost_usd, quantity_at_entry, note FROM cost_basis_overrides "
        "WHERE symbol = 'ETH'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 5000.0
    assert rows[0][1] == 2.0
    assert rows[0][2] == "CoinTracker EOY 2025-12-31"


def test_skips_zero_quantity_lots(tmp_path: Path, conn):
    """Closed-out lots (qty=0) are ignored — they're informational only
    in the CSV and would zero the quantity_at_entry."""
    csv_path = tmp_path / "eoy.csv"
    _write_csv(csv_path, [
        {"Asset": "ETH", "Amount": "0", "Acquisition Date": "01/15/2024",
         "Cost Basis (USD)": "0.00"},
        {"Asset": "ETH", "Amount": "1.0", "Acquisition Date": "06/01/2024",
         "Cost Basis (USD)": "3000.00"},
    ])

    stats = cointracker_lots.parse(csv_path, conn)

    assert stats.skipped_zero_qty == 1
    row = conn.execute(
        "SELECT cost_usd, quantity_at_entry FROM cost_basis_overrides "
        "WHERE symbol = 'ETH'"
    ).fetchone()
    assert row[0] == 3000.0
    assert row[1] == 1.0
