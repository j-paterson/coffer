# Coffer

A self-hosted personal finance dashboard. Syncs bank, credit card,
brokerage, and crypto data into a local SQLite database via a double-entry
ledger, categorizes spending, and displays everything in a browser. Data
never leaves your machine.

## Features

- **Double-entry ledger** — every dollar accounted for across all accounts
- **Multi-source sync** — SimpleFIN (banks), Zerion/Alchemy (crypto wallets),
  Coinbase (exchange), DefiLlama/GeckoTerminal (prices)
- **Net worth tracking** — daily time series with drill-down by account
- **Spending breakdown** — rule-based categorization, with optional [receipt itemization](docs/email.md) (requires Ollama + Gmail OAuth)
- **Investment tracking** — holdings, cost basis, realized P&L
- **Privacy mode** — blur all amounts for screen sharing

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- SQLite3
- Python 3.12+ (optional — needed for the categorization + reconciliation
  sidecar and the file-based parsers in `pipeline/`)

## Quick Start

```bash
git clone https://github.com/j-paterson/coffer.git
cd coffer
bun install

# Copy templates
cp finance.config.ts.example finance.config.ts
cp .env.example .env
chmod 600 .env
# Edit finance.config.ts to enable parsers (optional — empty config still boots)
# Edit .env to add API keys for the parsers you enabled

# Start the dashboard
bun run dev
```

Open <http://localhost:5173>. The database is created automatically on first
run; you'll see an empty dashboard until you enable a parser and run a sync.

## Configuration

Edit `finance.config.ts` to enable parsers and set walker options.
API keys live in `.env`. See `.env.example` for the full list.

## CLI

The dashboard's sync button invokes the same CLI under the hood. To run a
sync from a terminal (cron jobs, scripted backfills, etc.):

```bash
bun apps/cli/src/index.ts sync <parser-id>
```

Available parsers: `simplefin`, `defillama`, `zerion`, `alchemy`,
`geckoterminal`, `coinbase`.

Flags:

| Flag | Effect |
|------|--------|
| `--days N` | (simplefin only) override `lookback_days` |
| `--config <path>` | use a non-default `finance.config.ts` |
| `--events-fd N` | emit sync progress as JSON lines on file descriptor `N` |

Example:

```bash
bun apps/cli/src/index.ts sync simplefin --days 30
```

## Categorization & sidecar (optional)

Coffer ships with a Python sidecar in `pipeline/` that handles rule-based
categorization, transfer reconciliation, and price backfills. Without it
the dashboard still works, but every transaction stays in "Uncategorized"
and the server's post-sync hooks log skipped steps.

```bash
# From the repo root
python3.12 -m venv .venv
.venv/bin/pip install -e ./pipeline

# Copy and customize categorization rules
cp pipeline/rules.example.yaml pipeline/rules.yaml
# Edit pipeline/rules.yaml to add patterns for your merchants

# Apply rules to uncategorized transactions
.venv/bin/finance categorize --uncategorized
```

The dev server invokes `.venv/bin/finance` from the repo root after every
sync, so the venv must live at that exact path or the post-sync hooks
will be skipped.

Useful sidecar commands:

| Command | What it does |
|---------|--------------|
| `finance categorize --uncategorized` | Apply `pipeline/rules.yaml` to uncategorized txns |
| `finance reconcile dedup` | Merge duplicate transactions across sources |
| `finance reconcile transfers` | Link transfer counterparties between accounts |
| `finance backfill prices` | Fill missing daily prices for assets you hold |
| `finance --help` | Full subcommand list |

### Email receipt extraction (optional)

For per-line-item spending breakdown from receipt emails, install with
the `[email]` extras group and set up Ollama + a Gmail OAuth credential.
See [docs/email.md](docs/email.md).

## Architecture

For the accounting model, data flow, and monorepo layout, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## License

[MIT](LICENSE)
