"""Normalized dataclasses produced by parsers, consumed by ingest."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AccountRow:
    id: str
    display_name: str
    institution: str
    type: str
    currency: str = "USD"
    active: int = 1
    mode: str = "live"  # 'live' | 'manual'


@dataclass
class BalanceRow:
    account_id: str
    as_of: str
    value_usd: float
    source: str = "manual"


@dataclass
class HoldingRow:
    account_id: str
    as_of: str
    symbol: str
    asset_class: Optional[str]
    quantity: Optional[float]
    value_usd: float
    cost_basis: Optional[float]


@dataclass
class TransactionRow:
    id: str
    account_id: str
    date: str  # ISO
    amount: float  # signed; negative = outflow
    description: str
    source_file: str
    merchant: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[str] = None
    payee: Optional[str] = None         # Cleaned merchant name from source
    memo: Optional[str] = None          # Optional source-provided memo
    location_hint: Optional[str] = None # City/state inferred from description


@dataclass
class ParseResult:
    accounts: list[AccountRow] = field(default_factory=list)
    balances: list[BalanceRow] = field(default_factory=list)
    holdings: list[HoldingRow] = field(default_factory=list)
    transactions: list[TransactionRow] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
