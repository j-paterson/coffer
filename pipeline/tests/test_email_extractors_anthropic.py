"""Tests for AnthropicExtractor with mocked HTTP calls."""
import io
import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from finance_pipeline.emails.extractors.anthropic_api import AnthropicExtractor
from finance_pipeline.emails.interfaces import EmailContent, ExtractedReceipt


@pytest.fixture
def api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-12345")


@pytest.fixture
def sample_eml(tmp_path: Path) -> Path:
    eml = tmp_path / "test.eml"
    eml.write_text(
        "From: receipts@amazon.com\r\n"
        "Subject: Your order\r\n"
        "Content-Type: text/plain\r\n\r\n"
        "Order #123\nTotal: $50.00\n"
    )
    return eml


def _mock_response(payload: dict) -> MagicMock:
    body = json.dumps(payload).encode()
    resp = MagicMock()
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=None)
    resp.read = MagicMock(return_value=body)
    return resp


def test_missing_api_key_raises_systemexit(sample_eml, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    extractor = AnthropicExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="Total: $50", from_addr="x@y.com", subject="Receipt"
    )
    with pytest.raises(SystemExit) as exc_info:
        extractor.extract(content)
    assert "ANTHROPIC_API_KEY" in str(exc_info.value)
    assert "docs/email.md" in str(exc_info.value)


def test_extract_returns_receipt_on_success(sample_eml, api_key):
    api_response = {
        "content": [
            {
                "type": "text",
                "text": json.dumps({
                    "merchant": "Amazon",
                    "date": "2026-05-01",
                    "currency": "USD",
                    "subtotal": "45.00",
                    "tax": "5.00",
                    "total": "50.00",
                    "payment_method": "visa-1234",
                    "order_id": "123",
                    "items": [{"name": "Widget", "quantity": "1", "unit_price": "45.00", "line_total": "45.00"}],
                }),
            }
        ]
    }
    extractor = AnthropicExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="Total: $50", from_addr="x@y.com", subject="Receipt"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _mock_response(api_response)
        receipt = extractor.extract(content)
    assert isinstance(receipt, ExtractedReceipt)
    assert receipt.merchant == "Amazon"
    assert receipt.total == 50.0
    assert len(receipt.items) == 1


def test_extract_http_error_raises_friendly_systemexit(sample_eml, api_key):
    import urllib.error
    extractor = AnthropicExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "https://api.anthropic.com", 401, "Unauthorized", {}, io.BytesIO(b"{}")
        )
        with pytest.raises(SystemExit) as exc_info:
            extractor.extract(content)
    assert "docs/email.md" in str(exc_info.value)


def test_extract_url_error_raises_friendly_systemexit(sample_eml, api_key):
    import urllib.error
    extractor = AnthropicExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.side_effect = urllib.error.URLError("DNS failure")
        with pytest.raises(SystemExit) as exc_info:
            extractor.extract(content)
    assert "docs/email.md" in str(exc_info.value)


def test_extract_uses_configured_model(sample_eml, api_key):
    api_response = {
        "content": [{"type": "text", "text": json.dumps({"merchant": "", "date": "", "currency": "", "subtotal": "", "tax": "", "total": "", "payment_method": "", "order_id": "", "items": []})}],
    }
    extractor = AnthropicExtractor(model="claude-sonnet-4-6")
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _mock_response(api_response)
        extractor.extract(content)
    # Inspect the Request object passed to urlopen to verify the model is in the body
    call_args = mock_urlopen.call_args
    request = call_args[0][0]  # first positional arg
    body = json.loads(request.data.decode())
    assert body["model"] == "claude-sonnet-4-6"


def test_blank_fields_stay_blank(sample_eml, api_key):
    """Extractive contract: blank fields from the model stay blank in the receipt."""
    api_response = {
        "content": [{"type": "text", "text": json.dumps({
            "merchant": "",
            "date": "",
            "currency": "",
            "subtotal": "",
            "tax": "",
            "total": "",
            "payment_method": "",
            "order_id": "",
            "items": [],
        })}],
    }
    extractor = AnthropicExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="not a receipt", from_addr="a@b.com", subject="hi"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _mock_response(api_response)
        receipt = extractor.extract(content)
    assert receipt.merchant == ""
    assert receipt.total is None
    assert receipt.items == []
