# Architecture

## Overview

Coffer is a TypeScript + Bun monorepo. Code splits into reusable
packages (`packages/ledger`, `packages/parsers`, `packages/config`,
`packages/shared`) and three apps (`apps/cli`, `apps/server`,
`apps/web`). A single local SQLite database is the source of truth.
Parsers pull data from external providers into the database via a
typed Operations DSL. The web dashboard reads from the server's API,
which queries the same database.

## The accounting model

Coffer is a double-entry ledger. Every transaction is a set of
**postings** that sum to zero. A purchase debits an expense category
and credits the account that paid for it; a transfer debits the
destination and credits the source.

Two other primary record types augment postings:

- **Balance assertions** — provider-supplied ground-truth balances at
  a point in time (e.g. SimpleFIN reports "checking ended 2026-05-01
  at $1,234.56"). These let the walker correct drift without requiring
  every micro-transaction.
- **Position snapshots** — daily mark-to-market values for crypto
  holdings (qty × price_usd at as_of). Used for net-worth
  reconstruction of volatile asset accounts.

## Data flow

```
external API / file
    ↓
parser (packages/parsers/src/<provider>/)
    ↓ yields Operation[]
runner (packages/ledger/src/runner/)
    ↓ commits via gatekeepers
SQLite (raw_events, transactions_v2, postings, balance_assertions,
        position_snapshots, asset_prices, account_discoveries)
    ↓
walker (packages/ledger/src/walker/) — reconstructs daily series
    ↓
server (apps/server) — serves JSON
    ↓
web (apps/web) — renders charts
```

The runner is the only thing that writes to the postings, assertions,
snapshot, and price tables. Every parser is restricted to yielding
typed operations; it cannot bypass the runner. Raw payloads land in
`raw_events` for audit; that table is append-only.

## The walker

The walker (`packages/ledger/src/walker/walkV2.ts`) reconstructs a
daily balance series for any account from the underlying postings,
balance assertions, and position snapshots. The dashboard's net-worth
chart, spending breakdown, and investment views all run off the
walker.

Defaults: assets in `crypto`, `brokerage`, `retirement`, `alt`,
`real_estate`, and `savings` accounts are clamped to non-negative
when their derived balance would otherwise go negative. Net worth
is computed over full history; there is no walker floor.

## Storage

| Table | Contents |
|-------|----------|
| `accounts` | One row per account; id, type (checking/credit/crypto/...), display name |
| `transactions_v2` | One row per transaction; date, description, derived_by |
| `postings` | Two or more rows per transaction; account, amount (signed), currency |
| `balance_assertions` | Provider-supplied snapshots; account, as_of, balance, source |
| `position_snapshots` | Crypto holdings mark-to-market; position, as_of, qty, price_usd |
| `asset_prices` | Daily price per (chain, contract, symbol) tuple |
| `raw_events` | Append-only audit log of every parser payload |
| `data_sources` | Provider config and trust ranks for dedup decisions |
| `cohort_sessions` | Per-canonical session windows for time-segmented analysis |

Schema migrations live in `db/migrations/`. The app applies pending
migrations automatically on startup.

## Monorepo layout

```
packages/
  ledger/      Accounting core — schema, gatekeepers, runner, walker
  parsers/     Provider sync implementations
  config/      Config schema + defineConfig helper
  shared/      Cross-package types

apps/
  cli/         coffer CLI (sync, ingest, categorize commands)
  server/      Bun + Hono API
  web/         React + Vite + Tailwind dashboard

pipeline/      Python sidecar (reconcile, categorize, backfill prices) invoked from postSyncHooks
scripts/       Backfill and diagnostic tools
e2e/           Playwright end-to-end tests
db/migrations  SQL migration files (forward-only)
db/fixtures    Reproducible test datasets
```

## Sources

| Provider | Role |
|----------|------|
| SimpleFIN | Bank + credit card transactions and balances |
| Zerion | EVM crypto wallet positions (one snapshot per sync) |
| Alchemy | On-chain ERC-20 transfer history (for trade reconstruction) |
| Coinbase | Exchange account balances and trades (Advanced Trade API) |
| DefiLlama | Historical token prices (public, no auth) |
| GeckoTerminal | DEX-listed token prices (public, no auth) |

All sources are HTTPS pulls initiated by the CLI or server. No data
is sent outbound to any other party.
