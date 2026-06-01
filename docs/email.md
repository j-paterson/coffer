# Email receipt extraction (optional)

This feature fetches receipt emails from Gmail, runs them through a locally-hosted
NuExtract model (via Ollama), and inserts per-line-item data into the database.
The dashboard's Spending view and cashflow breakdown read these items to show
what you actually bought inside each transaction. The rest of the dashboard works
without this feature — you just won't see per-line-item drill-down.

## What it does

- **Fetch** — `finance sync email` searches Gmail for receipt-like messages and
  caches each raw email to `raw/email/YYYY-MM-DD/<id>.eml`.
- **Extract** — `finance extract-email` reads each cached `.eml`, strips it to
  plain text, and sends it to NuExtract (via Ollama) to pull out merchant, date,
  total, and line items. Amazon, Square/TeamWork, and Venmo emails use dedicated
  deterministic parsers and skip NuExtract.
- **Match** — `finance match-email` links each extracted receipt to the matching
  transaction in the ledger by amount and date.
- **Classify** — `finance classify-items` tags each line item with a category
  using keyword rules (same rules as `finance categorize`).

NuExtract is extractive by construction: it can only pull values that are
literally present in the email text. Fields NuExtract cannot find remain blank in
the database — there is no hallucination path.

## Prerequisites

### The `[email]` Python extras group

Install the pipeline with the email extras:

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e ./pipeline[email]
```

The `[email]` group adds four packages that are not needed for the core pipeline:
`google-api-python-client`, `google-auth-oauthlib`, `google-auth-httplib2`,
and `beautifulsoup4`. Without them, `finance sync email` and
`finance extract-email` will fail with a `ModuleNotFoundError` on import.

### Ollama running locally with NuExtract

Ollama is a local model server. You need it running with the `nuextract:3.8b`
model pulled before `finance extract-email` will work.

1. Install Ollama from <https://ollama.com/download>.
2. Start the server:
   ```bash
   ollama serve &
   ```
3. Pull the model (one-time, ~2 GB download):
   ```bash
   ollama pull nuextract:3.8b
   ```
4. Verify the server is reachable:
   ```bash
   curl http://localhost:11434/api/tags
   ```

By default Coffer talks to `http://localhost:11434/api/generate` using the
`nuextract:3.8b` model. Both can be overridden with env vars:

| Env var | Default | Purpose |
|---|---|---|
| `COFFER_OLLAMA_URL` | `http://localhost:11434/api/generate` | Ollama generate endpoint |
| `COFFER_RECEIPT_MODEL` | `nuextract:3.8b` | Model tag passed to Ollama |

Add overrides to your `.env` file if you run Ollama on a different host or
want to try a different NuExtract variant.

### Gmail OAuth client credential

Coffer reads your Gmail using the Gmail API with an installed-app OAuth flow.
Credentials are stored in `.secrets/` (gitignored).

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Create or select a project.
3. In the left sidebar, go to **APIs & Services → Library** and enable the
   **Gmail API**.
4. Go back to **Credentials**, click **Create credentials → OAuth client ID**.
5. Select **Desktop app** as the application type, give it any name, and click
   **Create**.
6. Click **Download JSON** on the newly created client and save the file as
   `.secrets/gmail_client.json` in the repo root.
7. On first run, `finance sync email` opens a browser tab for consent and
   writes the resulting token to `.secrets/gmail_token.json`. Subsequent runs
   use the cached token (auto-refreshed when it expires).

Both files are gitignored. Keep them secret — they grant read access to your Gmail.

## Running it

Run each step in order. After initial setup, incremental runs skip already-fetched
and already-processed emails.

```bash
# 1. Fetch new receipt emails from Gmail (caches .eml files, inserts pending rows)
.venv/bin/finance sync email

# 2. Run NuExtract on pending emails and write receipt fields + line items
.venv/bin/finance extract-email

# 3. Link extracted receipts to ledger transactions by amount + date
.venv/bin/finance match-email

# 4. (Optional) Tag line items with categories
.venv/bin/finance classify-items
```

Flags:

| Command | Useful flags |
|---|---|
| `finance sync email` | `--max-results N` (default 100), `--query "..."` (override Gmail search) |
| `finance extract-email` | `--limit N` (default 50, max emails per run) |
| `finance match-email` | `--refresh` (re-match already-matched emails) |
| `finance classify-items` | `--refresh` (re-classify items that already have a category) |

NuExtract is slow on CPU — expect 1–3 minutes per batch of 50 emails on first
run. The Amazon, Square, and Venmo fast paths are instant and bypass the model
entirely.

## Troubleshooting

**"Could not reach Ollama at http://localhost:11434/api/generate"**

Ollama is not running. Start it:

```bash
ollama serve &
```

Then verify:

```bash
curl http://localhost:11434/api/tags
```

If Ollama is on a different host or port, set `COFFER_OLLAMA_URL` in `.env`.

---

**"Gmail OAuth client credential missing at .secrets/gmail_client.json"**

The OAuth client JSON has not been placed at `.secrets/gmail_client.json`.
Follow prerequisite 3.3 above to create a Desktop OAuth client in Google Cloud
Console and download the JSON.

---

**Many receipts show blank items or no items at all**

NuExtract is extractive — it can only pull text that is literally present in the
email body. HTML-only emails that strip well to plain text are well-supported;
image-only emails (where the receipt is a PNG) yield nothing. Marketing emails
with only a total and no itemized table will produce a receipt total but no line
items. This is expected behavior, not a bug.

---

**`ModuleNotFoundError: No module named 'googleapiclient'` (or similar)**

The `[email]` extras group is not installed. Re-install with:

```bash
.venv/bin/pip install -e ./pipeline[email]
```
