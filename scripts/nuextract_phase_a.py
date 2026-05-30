"""Phase A validation for milestone 8b.

Runs NuExtract against real receipt samples and prints extracted JSON
alongside wall-clock latency. Purely a smoke-test script; not part of
the pipeline.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import urllib.request

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "nuextract:3.8b"

TEMPLATE = {
    "merchant": "",
    "date": "",
    "currency": "",
    "subtotal": "",
    "tax": "",
    "total": "",
    "payment_method": "",
    "order_id": "",
    "items": [
        {
            "name": "",
            "quantity": "",
            "unit_price": "",
            "line_total": "",
        }
    ],
}

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "raw" / "email" / "samples"


def build_prompt(body: str) -> str:
    tmpl = json.dumps(TEMPLATE, indent=2)
    return f"<|input|>\n### Template:\n{tmpl}\n### Text:\n{body}\n<|output|>\n"


def call_ollama(prompt: str) -> tuple[str, float]:
    payload = json.dumps(
        {"model": MODEL, "prompt": prompt, "stream": False, "options": {"temperature": 0}}
    ).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return data.get("response", ""), time.time() - t0


def clean(raw: str) -> str:
    return raw.replace("<|end-output|>", "").strip()


def main() -> None:
    samples = sorted(SAMPLES_DIR.glob("*.txt"))
    print(f"found {len(samples)} samples in {SAMPLES_DIR}\n")
    for path in samples:
        body = path.read_text()
        prompt = build_prompt(body)
        print("=" * 70)
        print(f"SAMPLE: {path.name}  ({len(body)} chars)")
        print("=" * 70)
        try:
            raw, elapsed = call_ollama(prompt)
        except Exception as e:
            print(f"ERROR calling Ollama: {e}")
            continue
        cleaned = clean(raw)
        print(f"latency: {elapsed:.2f}s")
        try:
            parsed = json.loads(cleaned)
            print("parsed JSON:")
            print(json.dumps(parsed, indent=2))
        except json.JSONDecodeError as e:
            print(f"JSON parse error: {e}")
            print("raw output:")
            print(cleaned)
        print()


if __name__ == "__main__":
    main()
