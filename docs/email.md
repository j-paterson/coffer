# Receipt extraction (optional)

This feature fetches receipt emails, runs them through an LLM to extract
structured data, and inserts per-line-item records into the database. The
dashboard's Spending view and cashflow breakdown read these items to show
what you actually bought inside each transaction. The rest of the dashboard
works without this feature — you just won't see per-line-item drill-down.

## What it does

- **Fetch** — `finance sync email` retrieves receipt-like messages from your
  configured source and caches each raw email to `raw/email/` as an `.eml` file.
- **Extract** — `finance extract-email` reads each cached `.eml`, strips it to
  plain text, and sends it to the configured extractor (local Ollama or a cloud
  API) to pull out merchant, date, total, and line items. Amazon, Square/TeamWork,
  and Venmo emails use dedicated deterministic parsers and skip the LLM entirely.
- **Match** — `finance match-email` links each extracted receipt to the matching
  transaction in the ledger by amount and date.
- **Classify** — `finance classify-items` tags each line item with a category
  using keyword rules.

## Pluggable backends

The pipeline has two backend abstractions — `EmailFetcher` and `ReceiptExtractor`
— and you pick one of each in `finance.config.ts`. They are independent: any
fetcher works with any extractor.

| Fetcher | What it does | Prerequisites |
|---------|--------------|---------------|
| `gmail` | Pulls receipts from Gmail via Gmail API | `[email]` extras + Gmail OAuth client |
| `imap` | Pulls receipts from any IMAP4-capable server | `[email]` extras + IMAP credentials |
| `manual` | Reads `.eml` files dropped into a local directory | `[email]` extras only |

| Extractor | What it does | Prerequisites |
|-----------|--------------|---------------|
| `ollama` | Local LLM extraction via Ollama + NuExtract | `[email]` extras + Ollama running + `nuextract:3.8b` pulled |
| `anthropic` | Cloud extraction via Claude API | `[email]` extras + `ANTHROPIC_API_KEY` |
| `openai` | Cloud extraction via OpenAI GPT API | `[email]` extras + `OPENAI_API_KEY` |

## Quick start (3 common configurations)

### Gmail + Ollama (private, free, slow)

The most privacy-respecting option: emails never leave your machine and
extraction runs locally. Slowest on CPU — expect 1–3 minutes per batch
of 50 emails on first run.

```ts
// finance.config.ts
export default defineConfig({
  parsers: {
    email: {
      fetcher: {
        backend: "gmail",
        // client_secret_path: ".secrets/gmail_client.json",  // default
        // token_cache_path:   ".secrets/gmail_token.json",   // default
      },
      extractor: {
        backend: "ollama",
        // url:   "http://localhost:11434/api/generate",  // default
        // model: "nuextract:3.8b",                      // default
      },
    },
  },
});
```

No `.env` entries are required for this configuration. You do need:

1. `[email]` extras installed (see [Setting up the \[email\] Python extras](#setting-up-the-email-python-extras))
2. Ollama running with `nuextract:3.8b` pulled (see [Ollama (local LLM)](#ollama-local-llm))
3. Gmail OAuth client JSON at `.secrets/gmail_client.json` (see [Gmail](#gmail))

On first run, `finance sync email` opens a browser tab for Gmail consent and
caches the token. Subsequent runs refresh the token automatically and only
fetch emails you haven't seen before.

---

### Gmail + Anthropic (cloud LLM, paid, fast)

Gmail for fetching, Claude Haiku for extraction. Faster and generally more
accurate on messy HTML emails. API costs are typically a few cents per 100
receipts.

```ts
// finance.config.ts
export default defineConfig({
  parsers: {
    email: {
      fetcher: {
        backend: "gmail",
      },
      extractor: {
        backend: "anthropic",
        // api_key_env: "ANTHROPIC_API_KEY",          // default
        // model:       "claude-haiku-4-5-20251001",  // default
      },
    },
  },
});
```

```env
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

You need:

1. `[email]` extras installed
2. Gmail OAuth client JSON at `.secrets/gmail_client.json` (see [Gmail](#gmail))
3. An Anthropic API key from <https://console.anthropic.com> (see [Anthropic (Claude API)](#anthropic-claude-api))

On first run, expect a browser-based Gmail consent step. Extraction is
near-instant — a batch of 50 emails typically finishes in under a minute.

---

### Manual + Ollama (no Gmail OAuth, fully local)

Drop `.eml` files into a directory and Ollama extracts them locally. Useful
for testing, for users who export emails from a desktop client, or as a
stepping stone before setting up IMAP or Gmail OAuth.

```ts
// finance.config.ts
export default defineConfig({
  parsers: {
    email: {
      fetcher: {
        backend: "manual",
        drop_directory: "receipts",  // relative to repo root
      },
      extractor: {
        backend: "ollama",
        // url:   "http://localhost:11434/api/generate",  // default
        // model: "nuextract:3.8b",                      // default
      },
    },
  },
});
```

No `.env` entries are required. You need:

1. `[email]` extras installed
2. Ollama running with `nuextract:3.8b` pulled (see [Ollama (local LLM)](#ollama-local-llm))
3. The `receipts/` directory to exist (`mkdir receipts`)

Drop or forward `.eml` files into `receipts/`. Each `finance sync email` run
picks up new files; already-processed filenames are tracked in
`receipts/.processed` so repeated runs are idempotent. The source files are
never deleted or moved.

## Setting up the [email] Python extras

All backends require the `[email]` extras group. Install (or reinstall) with:

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e ./pipeline[email]
```

The `[email]` group adds `google-api-python-client`, `google-auth-oauthlib`,
`google-auth-httplib2`, and `beautifulsoup4`. Without it, `finance sync email`
and `finance extract-email` fail with `ModuleNotFoundError` on import.

## Fetcher setup

### Gmail

Coffer reads Gmail using the Gmail API with an installed-app OAuth flow.
Credentials are stored in `.secrets/` (gitignored).

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Create or select a project.
3. In the left sidebar, click **APIs & Services → Library** and enable the
   **Gmail API**.
4. Return to **Credentials** and click **Create credentials → OAuth client ID**.
5. Select **Desktop app** as the application type, give it any name, and click
   **Create**.
6. Click **Download JSON** and save the file as `.secrets/gmail_client.json`
   in the repo root.
7. On first run, `finance sync email` opens a browser tab for consent and
   writes the token to `.secrets/gmail_token.json`. Subsequent runs use the
   cached token (auto-refreshed when it expires).

Both files are gitignored. Keep them secret — they grant read access to your Gmail.

Config keys (all optional, with defaults shown):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `client_secret_path` | `string` | `".secrets/gmail_client.json"` | Path to the OAuth client JSON |
| `token_cache_path` | `string` | `".secrets/gmail_token.json"` | Path to the cached OAuth token |
| `max_results` | `number` | `100` | Maximum messages per sync run |
| `query` | `string` | built-in receipt query | Gmail search string |

### IMAP

Works with any IMAP4-capable server (Fastmail, ProtonMail Bridge, iCloud Mail,
on-prem Dovecot, etc.). Uses Python's stdlib `imaplib` — no extra dependencies
beyond the `[email]` group.

1. Identify your server's hostname and port (typically `993` with TLS).
2. Create env vars for your credentials:

```env
# .env
IMAP_USERNAME=you@yourdomain.com
IMAP_PASSWORD=your-app-password
```

3. Add the fetcher block to `finance.config.ts`:

```ts
fetcher: {
  backend: "imap",
  host: "imap.yourdomain.com",
  port: 993,            // default 993
  use_ssl: true,        // default true
  username_env: "IMAP_USERNAME",
  password_env: "IMAP_PASSWORD",
  folder: "INBOX",      // default "INBOX"
},
```

Config keys:

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `host` | `string` | yes | — | IMAP server hostname |
| `port` | `number` | no | `993` | IMAP server port |
| `use_ssl` | `boolean` | no | `true` | Use IMAP4_SSL (vs plain IMAP4) |
| `username_env` | `string` | yes | — | Name of env var holding the username |
| `password_env` | `string` | yes | — | Name of env var holding the password |
| `folder` | `string` | no | `"INBOX"` | Mailbox folder to search |

`finance sync email` fetches UNSEEN messages and marks them as Seen on the
server after caching.

### Manual (.eml drop-in)

Point the fetcher at a local directory and drop `.eml` files there manually.
Useful for testing or for email clients that can export raw messages.

1. Create the directory:

```bash
mkdir receipts
```

2. Configure the fetcher:

```ts
fetcher: {
  backend: "manual",
  drop_directory: "receipts",  // relative or absolute path
},
```

3. Drop `.eml` files into the directory. Files are processed in
   modification-time order. Already-processed filenames are tracked in
   `<drop_directory>/.processed` so repeated runs are safe. Source files are
   never deleted.

Config keys:

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `drop_directory` | `string` | yes | Directory containing `.eml` files to process |

## Extractor setup

### Ollama (local LLM)

Ollama serves `nuextract:3.8b` locally. No API key or network connection
required after the initial model download.

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

The extractor talks to `http://localhost:11434/api/generate` using
`nuextract:3.8b` by default. Override either in `finance.config.ts`:

```ts
extractor: {
  backend: "ollama",
  url:   "http://192.168.1.10:11434/api/generate",  // if Ollama is on another host
  model: "nuextract:3.8b",
},
```

Or via env vars (used as fallback when `url`/`model` are not set in config):

| Env var | Default | Purpose |
|---------|---------|---------|
| `COFFER_OLLAMA_URL` | `http://localhost:11434/api/generate` | Ollama generate endpoint |
| `COFFER_RECEIPT_MODEL` | `nuextract:3.8b` | Model tag passed to Ollama |

### Anthropic (Claude API)

Sends each receipt to Claude Haiku via the Anthropic Messages API. No local
model or Ollama required.

1. Create an account at <https://console.anthropic.com> and generate an API key.
2. Add the key to `.env`:
   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. The extractor is now ready. Optionally override the model in
   `finance.config.ts`:
   ```ts
   extractor: {
     backend: "anthropic",
     api_key_env: "ANTHROPIC_API_KEY",       // default; rename if you prefer
     model: "claude-haiku-4-5-20251001",     // default
   },
   ```

Config keys:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `api_key_env` | `string` | `"ANTHROPIC_API_KEY"` | Name of the env var holding the API key |
| `model` | `string` | `"claude-haiku-4-5-20251001"` | Anthropic model ID |

### OpenAI (GPT API)

Sends each receipt to GPT-4o-mini via the OpenAI Chat Completions API. No
local model or Ollama required.

1. Create an account at <https://platform.openai.com> and generate an API key.
2. Add the key to `.env`:
   ```env
   OPENAI_API_KEY=sk-...
   ```
3. Optionally override the model in `finance.config.ts`:
   ```ts
   extractor: {
     backend: "openai",
     api_key_env: "OPENAI_API_KEY",  // default; rename if you prefer
     model: "gpt-4o-mini",           // default
   },
   ```

Config keys:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `api_key_env` | `string` | `"OPENAI_API_KEY"` | Name of the env var holding the API key |
| `model` | `string` | `"gpt-4o-mini"` | OpenAI model ID |

## Running it

Run each step in order. Incremental runs skip already-fetched and
already-processed emails.

```bash
# 1. Fetch new receipt emails and cache .eml files
.venv/bin/finance sync email

# 2. Run the configured extractor on pending emails
.venv/bin/finance extract-email

# 3. Link extracted receipts to ledger transactions by amount + date
.venv/bin/finance match-email

# 4. (Optional) Tag line items with categories
.venv/bin/finance classify-items
```

Flags:

| Command | Useful flags |
|---------|-------------|
| `finance sync email` | `--max-results N` (default 100), `--query "..."` (override Gmail search query) |
| `finance extract-email` | `--limit N` (default 50, max emails per run) |
| `finance match-email` | `--refresh` (re-match already-matched emails) |
| `finance classify-items` | `--refresh` (re-classify items that already have a category) |

**How the config reaches the Python sidecar.** When the TypeScript server
starts (`bun run dev`), it reads `finance.config.ts`, validates the
`parsers.email` block against the Zod schema, and writes the resolved config
to `db/.cache/email-config.json`. The Python CLI reads that file on each
invocation. If you edit `finance.config.ts`, restart the dev server for the
change to take effect. If you invoke the CLI without the server running (no
`db/.cache/email-config.json`), the pipeline falls back to Gmail + Ollama
defaults.

## Troubleshooting

**"Could not reach Ollama at http://localhost:11434/api/generate ..."**

Ollama is not running. Start it:

```bash
ollama serve &
```

Then confirm the model is pulled:

```bash
ollama list  # should show nuextract:3.8b
```

If Ollama runs on a different host or port, set `COFFER_OLLAMA_URL` in `.env`
or set the `url` key in `finance.config.ts` under `extractor`.

---

**"Gmail OAuth client credential missing at .secrets/gmail_client.json ..."**

You haven't created the OAuth client JSON. Follow the [Gmail](#gmail) fetcher
setup section above to create a Desktop app credential in Google Cloud Console
and save the downloaded JSON to `.secrets/gmail_client.json`.

---

**"Anthropic API key not set: $ANTHROPIC_API_KEY ..."**

The `ANTHROPIC_API_KEY` env var is missing. Add it to `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

If you renamed the env var using `api_key_env` in `finance.config.ts`, set
that variable instead.

---

**"OpenAI API key not set: $OPENAI_API_KEY ..."**

The `OPENAI_API_KEY` env var is missing. Add it to `.env`:

```env
OPENAI_API_KEY=sk-...
```

---

**"IMAP credentials not set: $IMAP_USERNAME and/or $IMAP_PASSWORD ..."**

The env vars named by `username_env` and `password_env` in your IMAP fetcher
config are not set. Check your `.env` file and confirm the variable names match
what you configured.

---

**"Anthropic API error: HTTP 401 Unauthorized ..." / "OpenAI API error: HTTP 401 Unauthorized ..."**

Your API key is invalid or has been revoked. Regenerate it at
<https://console.anthropic.com> or <https://platform.openai.com> and update
`.env`.

---

**"Manual fetcher drop directory does not exist: receipts ..."**

The directory configured in `parsers.email.fetcher.drop_directory` doesn't
exist. Create it:

```bash
mkdir receipts
```

---

**Many receipts show blank items or no items at all**

All extractors follow an extractive contract: they only pull values that are
literally present in the email text. HTML-only emails that strip cleanly to
plain text are well-supported; image-only emails (where the receipt is a PNG)
yield nothing. Marketing emails with only a total and no itemized table
produce a receipt total but no line items. This is expected behavior.

Cloud extractors (Anthropic, OpenAI) generally handle messy HTML better than
NuExtract because they understand layout context, but they can't extract
what isn't in the text.

---

**`ModuleNotFoundError: No module named 'googleapiclient'` (or similar)**

The `[email]` extras group is not installed. Re-install:

```bash
.venv/bin/pip install -e ./pipeline[email]
```

---

**Configuration change not picked up**

The TypeScript server writes `db/.cache/email-config.json` on startup. If you
edited `finance.config.ts`, restart `bun run dev` for the change to take
effect. Manual CLI invocations when the server isn't running will fall back to
Gmail + Ollama defaults until the cache file is present.
