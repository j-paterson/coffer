"""Tests for OpenAIExtractor with mocked HTTP calls."""
import io
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from finance_pipeline.emails.extractors.openai_api import OpenAIExtractor
from finance_pipeline.emails.interfaces import EmailContent, ExtractedReceipt


@pytest.fixture
def api_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-67890")


@pytest.fixture
def sample_eml(tmp_path: Path) -> Path:
    eml = tmp_path / "test.eml"
    eml.write_text(
        "From: receipts@uber.com\r\n"
        "Subject: Your ride receipt\r\n"
        "Content-Type: text/plain\r\n\r\n"
        "Trip $15.00\nTotal: $15.00\n"
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
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    extractor = OpenAIExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with pytest.raises(SystemExit) as exc_info:
        extractor.extract(content)
    assert "OPENAI_API_KEY" in str(exc_info.value)
    assert "docs/email.md" in str(exc_info.value)


def test_extract_returns_receipt_on_success(sample_eml, api_key):
    api_response = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": json.dumps({
                        "merchant": "Uber",
                        "date": "2026-05-01",
                        "currency": "USD",
                        "subtotal": "13.50",
                        "tax": "1.50",
                        "total": "15.00",
                        "payment_method": "amex-9999",
                        "order_id": "UB123",
                        "items": [{"name": "Trip", "quantity": "1", "unit_price": "13.50", "line_total": "13.50"}],
                    }),
                },
            }
        ]
    }
    extractor = OpenAIExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="Total $15", from_addr="x@y.com", subject="Receipt"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _mock_response(api_response)
        receipt = extractor.extract(content)
    assert isinstance(receipt, ExtractedReceipt)
    assert receipt.merchant == "Uber"
    assert receipt.total == 15.0
    assert len(receipt.items) == 1


def test_uses_bearer_auth_header(sample_eml, api_key):
    api_response = {
        "choices": [{"message": {"content": json.dumps({"merchant": "", "date": "", "currency": "", "subtotal": "", "tax": "", "total": "", "payment_method": "", "order_id": "", "items": []})}}],
    }
    extractor = OpenAIExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _mock_response(api_response)
        extractor.extract(content)
    request = mock_urlopen.call_args[0][0]
    auth = request.get_header("Authorization")
    assert auth == "Bearer sk-test-67890"


def test_uses_json_response_format(sample_eml, api_key):
    api_response = {
        "choices": [{"message": {"content": json.dumps({"merchant": "", "date": "", "currency": "", "subtotal": "", "tax": "", "total": "", "payment_method": "", "order_id": "", "items": []})}}],
    }
    extractor = OpenAIExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _mock_response(api_response)
        extractor.extract(content)
    request = mock_urlopen.call_args[0][0]
    body = json.loads(request.data.decode())
    assert body["response_format"] == {"type": "json_object"}


def test_extract_http_error_raises_friendly_systemexit(sample_eml, api_key):
    import urllib.error
    extractor = OpenAIExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "https://api.openai.com", 401, "Unauthorized", {}, io.BytesIO(b"{}")
        )
        with pytest.raises(SystemExit) as exc_info:
            extractor.extract(content)
    assert "docs/email.md" in str(exc_info.value)


def test_extract_url_error_raises_friendly_systemexit(sample_eml, api_key):
    import urllib.error
    extractor = OpenAIExtractor()
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.side_effect = urllib.error.URLError("DNS failure")
        with pytest.raises(SystemExit) as exc_info:
            extractor.extract(content)
    assert "docs/email.md" in str(exc_info.value)


def test_uses_configured_model(sample_eml, api_key):
    api_response = {
        "choices": [{"message": {"content": json.dumps({"merchant": "", "date": "", "currency": "", "subtotal": "", "tax": "", "total": "", "payment_method": "", "order_id": "", "items": []})}}],
    }
    extractor = OpenAIExtractor(model="gpt-4o")
    content = EmailContent(
        eml_path=sample_eml, body_text="x", from_addr="a@b.com", subject="r"
    )
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _mock_response(api_response)
        extractor.extract(content)
    request = mock_urlopen.call_args[0][0]
    body = json.loads(request.data.decode())
    assert body["model"] == "gpt-4o"
