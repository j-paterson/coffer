# diagnose

Read-only CLI for inspecting `db/finance.sqlite`. No network, no ingest,
no writes. Mirrors walkV2's source-priority logic so numbers match the
API.

## Running

```bash
bun run scripts/diagnose/diagnose.ts <command> [...args]
```

Or add to `dashboard/package.json`:

```json
{ "scripts": { "diagnose": "bun run scripts/diagnose/diagnose.ts" } }
```

## Commands

### `networth <YYYY-MM-DD>`

Tree drill-down of net worth on one date. For each account, shows the
value and — for `skip_pad` accounts — per-position attribution: which
source won the rank battle, on which date (stale forward-fill flagged),
and which duplicate contract-empty rows were dropped.

```bash
bun run scripts/diagnose/diagnose.ts networth 2024-08-31
```

### `symbol <SYM>`

Every mention of a symbol across `positions`, `position_snapshots`,
`asset_prices`, `raw_events`. Flags ingestion gaps (e.g. "in
raw_events but no positions row" or "no asset_prices — blocks alchemy
backfill").

```bash
bun run scripts/diagnose/diagnose.ts symbol DEGEN
```

### `source <NAME>`

Row counts, date range, accounts & symbols covered for one data source.
Also shows the `data_sources` registry row (kind, rank, enabled).

```bash
bun run scripts/diagnose/diagnose.ts source coinbase-direct
bun run scripts/diagnose/diagnose.ts source backfill:txn-walk
```

### `gaps [--min-txns N] [--min-value USD]`

Coverage audit:
1. Symbols in `cointracker` raw_events with no `asset_prices` coverage
   (these vanish if CoinTracker is fully retired).
2. Positions with zero snapshots.
3. `position_snapshots` sources not registered in `data_sources`.
4. `balance_assertions` sources not registered in `data_sources`.

```bash
bun run scripts/diagnose/diagnose.ts gaps --min-value 1000
```
