"""Tests for the deterministic TeamWork / Square invoice parser.

NuExtract misses single-item pipe-table invoices and occasionally fails
on long multi-item ones; the parser exists to keep those extractions
reliable.
"""
from __future__ import annotations

from finance_pipeline.emails import teamwork


def test_parse_single_item():
    body = (
        "Invoice summary\n\n"
        "Deposit | $1,000.00\n"
        "Subtotal | $1,000.00\n"
        "Total Due | $1,000.00\n"
    )
    result = teamwork.parse(body)
    assert result is not None
    assert result["total"] == "$1,000.00"
    assert [(it["name"], it["line_total"]) for it in result["items"]] == [
        ("Deposit", "$1,000.00"),
    ]


def test_parse_multi_item_with_continuation():
    body = (
        "Invoice summary\n\n"
        "Waterproofing bathrooms | $10,408.37\n"
        'Avocado Premium Leathered Finish 3cm 126.5" X 75.5" | $13,504.60\n'
        "($6,752.30 ea.) x 2 | \n"
        "Calacatta Viraldi 2CM Jumbo, polished | $3,489.12\n"
        "Subtotal | $26,902.09\n"
        "Total Due | $26,902.09\n"
    )
    result = teamwork.parse(body)
    assert result is not None
    names = [it["name"] for it in result["items"]]
    assert len(names) == 3
    # Continuation attaches to the prior item.
    assert names[1].endswith("($6,752.30 ea.) x 2")


def test_parse_returns_none_without_section():
    assert teamwork.parse("Hello world, nothing to see here") is None


def test_parse_stops_at_subtotal():
    # A line that looks item-shaped after Subtotal must not be captured.
    body = (
        "Invoice summary\n\n"
        "Real item | $100.00\n"
        "Subtotal | $100.00\n"
        "Payments\n"
        "$100.00 on 01/01/2025 (ACH: Bank) | \n"
    )
    result = teamwork.parse(body)
    assert [it["name"] for it in result["items"]] == ["Real item"]
