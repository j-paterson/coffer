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
- **Spending breakdown** — rule-based categorization with receipt itemization
- **Investment tracking** — holdings, cost basis, realized P&L
- **Privacy mode** — blur all amounts for screen sharing

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- SQLite3
- Python 3.12+ (optional — only for the legacy file-based parsers in `pipeline/`)

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

## Architecture

For the accounting model, data flow, and monorepo layout, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## License

[MIT](LICENSE)
