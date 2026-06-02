"""Contract tests for EmailFetcher and ReceiptExtractor ABCs."""
import pytest
from finance_pipeline.emails.interfaces import (
    EmailFetcher,
    ReceiptExtractor,
    ExtractedReceipt,
    EmailContent,
)


def test_email_fetcher_cannot_be_instantiated_directly():
    """ABC raises TypeError on direct instantiation."""
    with pytest.raises(TypeError):
        EmailFetcher()  # type: ignore[abstract]


def test_receipt_extractor_cannot_be_instantiated_directly():
    with pytest.raises(TypeError):
        ReceiptExtractor()  # type: ignore[abstract]


def test_extracted_receipt_has_required_fields():
    """ExtractedReceipt dataclass surfaces the fields NuExtract produces."""
    r = ExtractedReceipt(
        merchant="Amazon",
        date="2026-05-01",
        currency="USD",
        subtotal=100.0,
        tax=8.0,
        total=108.0,
        payment_method="visa-1234",
        order_id="ORD-123",
        items=[{"name": "Widget", "qty": 1, "price": 100.0}],
    )
    assert r.merchant == "Amazon"
    assert len(r.items) == 1


def test_extracted_receipt_allows_blank_fields():
    """NuExtract's extractive guarantee: blank fields stay blank."""
    r = ExtractedReceipt(
        merchant="",
        date="",
        currency="",
        subtotal=None,
        tax=None,
        total=None,
        payment_method="",
        order_id="",
        items=[],
    )
    assert r.merchant == ""
    assert r.items == []


def test_email_content_dataclass():
    """EmailContent bundles pre-parsed email fields for extractors."""
    from pathlib import Path
    from finance_pipeline.emails.interfaces import EmailContent
    c = EmailContent(
        eml_path=Path("/tmp/test.eml"),
        body_text="receipt body",
        from_addr="sender@example.com",
        subject="Your receipt",
    )
    assert c.body_text == "receipt body"
