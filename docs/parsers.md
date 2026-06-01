# Parser configuration

Coffer ships six parsers. Enable the ones you need in `finance.config.ts`
and set the required env vars in `.env`.

## Overview

| Parser | What it does | Auth required |
|---|---|---|
| `simplefin` | Syncs bank and credit-card accounts (transactions, balances, positions) via the SimpleFIN Bridge | Access URL (obtained from the bridge after linking your banks) |
| `zerion` | Syncs EVM wallet positions and historical prices via the Zerion API | API key |
| `alchemy` | Syncs EVM wallet token balances across five chains via the Alchemy API | API key |
| `coinbase` | Syncs Coinbase exchange accounts and transaction history via the Advanced Trade API | CDP key name + EC private key |
| `defillama` | Fetches historical daily prices for arbitrary assets via the DefiLlama Coins API | None (free public API) |
| `geckoterminal` | Fetches historical OHLCV prices for on-chain liquidity pools via the GeckoTerminal API | None (free public API) |

---

## simplefin

SimpleFIN is a bridge that connects to your bank, credit-card, and
brokerage accounts. It delivers transactions, live balances, and brokerage
holdings in a single JSON feed.

### Credentials

1. Go to <https://beta-bridge.simplefin.org>.
2. Link your institutions in the bridge's web UI.
3. Click **"Get access URL"** — this produces a one-time setup token.
4. Exchange the setup token for a permanent access URL by POSTing to it:
   `curl -X POST <setup-token-url>`. The response body is your `SIMPLEFIN_ACCESS_URL`.

### Env vars

```env
SIMPLEFIN_ACCESS_URL=https://user:pass@bridge.simplefin.org/simplefin
```

The value is a Basic-Auth URL (`https://user:pass@host/path`). Keep it
secret — it grants read access to all linked accounts.

### Config block

```ts
parsers: {
  simplefin: {
    // Name of the env var that holds the access URL.
    // Default: "SIMPLEFIN_ACCESS_URL"
    access_url_env: "SIMPLEFIN_ACCESS_URL",

    // How many calendar days of history to request on each sync.
    // Default: 90
    lookback_days: 90,

    // Whether to include pending (unsettled) transactions.
    // Default: false
    include_pending: false,

    // Per-account overrides keyed by the SimpleFIN account ID
    // (the "id" field in the API response).
    // Each entry may set any combination of type, display_name, institution.
    // Default: {}
    account_overrides: {
      "org-abc-checking-123": {
        type: "checking",
        display_name: "Main Checking",
        institution: "My Bank",
      },
    },
  },
},
```

Config keys:

| Key | Type | Default | Description |
|---|---|---|---|
| `access_url_env` | `string` | `"SIMPLEFIN_ACCESS_URL"` | Name of the env var holding the access URL |
| `lookback_days` | `number` (int, > 0) | `90` | Days of transaction history to request |
| `include_pending` | `boolean` | `false` | Include pending/unsettled transactions |
| `account_overrides` | `Record<string, { type?, display_name?, institution? }>` | `{}` | Per-account metadata overrides keyed by SimpleFIN account ID |

### Gotchas

- The access URL is a **permanent credential**, not a session token. Treat
  it like a password.
- The setup token (from the bridge) is single-use. If you lose the access URL
  before saving it, generate a new setup token and re-exchange.
- SimpleFIN requests are chunked into 90-day windows internally, so
  `lookback_days` values larger than 90 result in multiple API calls.
- The bridge's free tier covers most retail banks; some institutions require
  a paid plan on the bridge side.

---

## zerion

Zerion aggregates EVM wallet positions across dozens of chains and DeFi
protocols. Coffer uses it to pull current token balances and historical
portfolio value.

### Credentials

Obtain an API key at <https://developers.zerion.io>.

### Env vars

```env
ZERION_API_KEY=zk_prod_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Config block

```ts
parsers: {
  zerion: {
    // Name of the env var holding the Zerion API key.
    // Default: "ZERION_API_KEY"
    api_key_env: "ZERION_API_KEY",

    // EVM wallet addresses to sync (checksummed or lowercase).
    // Empty array → parser exits immediately with no warnings.
    wallets: [
      "0xYourWalletAddressHere",
    ],

    // Drop positions worth less than this in USD before processing.
    // Default: 1.0
    min_value_usd: 1.0,

    // TTL in seconds for wallet-chart and fungible-chart cache entries.
    // Default: 86400 (24 hours)
    chart_cache_ttl_seconds: 86400,

    // Zerion v1 base URL. Override only for tests or regional mirrors.
    // Default: "https://api.zerion.io/v1"
    base_url: "https://api.zerion.io/v1",
  },
},
```

Config keys:

| Key | Type | Default | Description |
|---|---|---|---|
| `api_key_env` | `string` | `"ZERION_API_KEY"` | Name of the env var holding the API key |
| `wallets` | `string[]` (EVM addresses) | `[]` | Wallet addresses to sync |
| `min_value_usd` | `number` (>= 0) | `1.0` | Minimum position value in USD; smaller positions are dropped |
| `chart_cache_ttl_seconds` | `number` (int, > 0) | `86400` | TTL for chart cache entries |
| `base_url` | `string` (URL) | `"https://api.zerion.io/v1"` | Zerion API base URL |

### Gotchas

- Zerion free-tier keys have rate limits. High `chart_cache_ttl_seconds`
  values (the default 24h is appropriate) reduce repeat calls.
- Positions below `min_value_usd` are filtered before any chain grouping,
  so dust balances don't generate accounts or price lookups.

---

## alchemy

Alchemy provides on-chain token balance data across five EVM chains.
Coffer uses it to snapshot wallet positions (native and ERC-20 tokens).

### Credentials

Obtain an API key at <https://www.alchemy.com>. A single key works across
all supported chains.

### Env vars

```env
ALCHEMY_API_KEY=your_alchemy_api_key_here
```

### Config block

```ts
parsers: {
  alchemy: {
    // Name of the env var holding the Alchemy API key.
    // Default: "ALCHEMY_API_KEY"
    api_key_env: "ALCHEMY_API_KEY",

    // EVM wallet addresses to sync (checksummed or lowercase).
    // Empty array → parser exits immediately with no warnings.
    wallets: [
      "0xYourWalletAddressHere",
    ],

    // Chains to query. Must be a subset of the five supported values.
    // Default: all five chains
    chains: ["ethereum", "base", "polygon", "optimism", "arbitrum"],

    // TTL in seconds for token metadata cache entries (symbol, decimals).
    // Metadata is immutable per (chain, contract), so 30 days is safe.
    // Default: 2592000 (30 days)
    metadata_cache_ttl_seconds: 2592000,
  },
},
```

Config keys:

| Key | Type | Default | Description |
|---|---|---|---|
| `api_key_env` | `string` | `"ALCHEMY_API_KEY"` | Name of the env var holding the API key |
| `wallets` | `string[]` (EVM addresses) | `[]` | Wallet addresses to sync |
| `chains` | `Array<"ethereum" \| "base" \| "polygon" \| "optimism" \| "arbitrum">` | all five | Chains to query |
| `metadata_cache_ttl_seconds` | `number` (int, > 0) | `2592000` | TTL for token metadata cache entries |

### Gotchas

- Alchemy free-tier accounts are rate-limited. Querying many wallets across
  all five chains on every sync can exhaust request quotas quickly; consider
  restricting `chains` to the ones you actually use.
- The parser only emits an account and its positions if at least one
  non-zero position is found on a given chain. Empty wallets on a chain
  produce no output.

---

## coinbase

Syncs Coinbase exchange accounts using both the V3 (Advanced Trade) and
V2 (legacy) APIs. Produces account discoveries, transaction history, and
daily position snapshots.

### Credentials

Create a **CDP API key** (not the legacy API key) at
<https://www.coinbase.com/settings/api>. Coinbase will give you:

- A key name in the form `organizations/{org_id}/apiKeys/{key_id}`
- An EC private key as a PEM block

### Env vars

```env
COINBASE_KEY_NAME=organizations/abc123/apiKeys/def456
COINBASE_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEI...\n-----END EC PRIVATE KEY-----\n"
```

### Config block

```ts
parsers: {
  coinbase: {
    // Name of the env var holding the CDP key name.
    // Default: "COINBASE_KEY_NAME"
    key_name_env: "COINBASE_KEY_NAME",

    // Name of the env var holding the EC private key (PEM string).
    // Default: "COINBASE_PRIVATE_KEY"
    private_key_env: "COINBASE_PRIVATE_KEY",

    // Maximum API requests per minute (token-bucket rate limiter).
    // Default: 1500
    rate_per_minute: 1500,

    // TTL in seconds for the accounts list cache.
    // Set to 0 to disable caching of the accounts list.
    // Default: 300 (5 minutes)
    accounts_cache_ttl_seconds: 300,

    // Overrides for the currency → chain mapping.
    // Merged on top of the built-in defaults (BTC→bitcoin, ETH→ethereum,
    // SOL→solana, MATIC→polygon, AVAX→avalanche, and others).
    // Use this to handle exchange-only tokens or stablecoins on non-default chains.
    // Default: {}
    chain_map: {
      MYTOKEN: "ethereum",
    },
  },
},
```

Config keys:

| Key | Type | Default | Description |
|---|---|---|---|
| `key_name_env` | `string` | `"COINBASE_KEY_NAME"` | Name of the env var holding the CDP key name |
| `private_key_env` | `string` | `"COINBASE_PRIVATE_KEY"` | Name of the env var holding the EC private key (PEM) |
| `rate_per_minute` | `number` (int, > 0) | `1500` | API request rate limit |
| `accounts_cache_ttl_seconds` | `number` (int, >= 0) | `300` | TTL for accounts list cache; 0 disables caching |
| `chain_map` | `Record<string, string>` | `{}` | Additional or override currency → chain mappings |

Built-in `chain_map` defaults: `BTC→bitcoin`, `ETH→ethereum`, `USDC→ethereum`,
`USDT→ethereum`, `SOL→solana`, `MATIC→polygon`, `AVAX→avalanche`,
`LINK→ethereum`, `DAI→ethereum`, `LTC→litecoin`.

### Gotchas

- The private key must be a **PEM-encoded EC key** (not RSA, not a hex
  string). In `.env`, literal newlines inside the PEM block must be
  encoded as `\n` since `.env` files are single-line per variable.
- If a currency has no chain mapping (built-in or via `chain_map`), the
  parser emits a `sync_warning` with scope `unknown_currency` and skips
  position snapshots for that wallet.
- The parser queries both the V3 and V2 Coinbase APIs. V3 gives current
  balances; V2 gives full transaction history. Both are required for
  accurate cost-basis reconstruction.

---

## defillama

DefiLlama Coins is a free, public API for historical daily prices across
thousands of assets identified by chain and contract address (or by
CoinGecko ID for major assets). No API key is required.

### Credentials

None.

### Env vars

None.

### Config block

```ts
parsers: {
  defillama: {
    // Asset triples to fetch prices for.
    // Empty array → parser exits immediately, no warnings.
    targets: [
      {
        // Ticker symbol used in Coffer's ledger (e.g. "ETH", "USDC").
        symbol: "ETH",

        // Chain identifier as used by DefiLlama (e.g. "ethereum", "base").
        // Set to null if resolving by CoinGecko ID only.
        chain: "ethereum",

        // ERC-20 contract address on the given chain.
        // Set to null for native/major assets resolved by CoinGecko ID.
        contract: null,

        // Start date (inclusive, YYYY-MM-DD). Null falls back to floor_date.
        since: null,
      },
    ],

    // CoinGecko ID overrides, keyed by uppercase symbol.
    // Merged on top of the parser's 31-entry built-in map.
    // Set a value to null to suppress the default mapping for that symbol.
    // Default: {}
    cg_overrides: {
      MYTOKEN: "my-token-coingecko-id",
    },

    // Fallback start date when a target's `since` is null.
    // Default: "2017-01-01"
    floor_date: "2017-01-01",

    // Coin keys to skip (populated automatically from cache; managed by Coffer).
    // You normally do not need to set this manually.
    // Default: []
    skip_coin_keys: [],

    // DefiLlama Coins API base URL. Override only for tests or mirrors.
    // Default: "https://coins.llama.fi"
    base_url: "https://coins.llama.fi",
  },
},
```

Config keys:

| Key | Type | Default | Description |
|---|---|---|---|
| `targets` | `DefiLlamaTarget[]` | `[]` | Assets to price (see target fields below) |
| `cg_overrides` | `Record<string, string \| null>` | `{}` | CoinGecko ID overrides by uppercase symbol |
| `floor_date` | `string` (YYYY-MM-DD) | `"2017-01-01"` | Fallback start date when a target's `since` is null |
| `skip_coin_keys` | `string[]` | `[]` | Coin keys to skip (managed automatically) |
| `base_url` | `string` (URL) | `"https://coins.llama.fi"` | API base URL |

`DefiLlamaTarget` fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `symbol` | `string` | yes | Ticker symbol as used in the ledger |
| `chain` | `string \| null` | yes | DefiLlama chain name, or null |
| `contract` | `string \| null` | yes | Contract address, or null for native/CoinGecko-resolved assets |
| `since` | `string \| null` (YYYY-MM-DD) | no | Start date override; null falls back to `floor_date` |

### Gotchas

- DefiLlama is a free, unauthenticated API with no published rate limit.
  Be respectful — avoid requesting the same coin key repeatedly by keeping
  `floor_date` as late as practical.
- When both `chain` and `contract` are null, the parser resolves the asset
  solely by CoinGecko ID (via `cg_overrides` or the built-in map). If the
  symbol has no mapping, it emits a warning and skips that target.
- `skip_coin_keys` is managed automatically: coin keys that return no data
  are recorded in the database with a 30-day TTL and skipped on future
  syncs to avoid wasted calls. You do not normally need to set it manually.

---

## geckoterminal

GeckoTerminal provides OHLCV candlestick data for on-chain liquidity
pools across many EVM and non-EVM networks. Useful for tokens not covered
by DefiLlama. No API key is required.

### Credentials

None.

### Env vars

None.

### Config block

```ts
parsers: {
  geckoterminal: {
    // Liquidity-pool targets to fetch prices for. At least one is required.
    targets: [
      {
        // Ticker symbol as used in the ledger.
        symbol: "MYTOKEN",

        // Chain name (must match a key in chain_slugs or the built-in defaults).
        chain: "ethereum",

        // ERC-20 token contract address (0x-prefixed, 40 hex chars).
        contract: "0xTokenContractAddress",

        // Optional date range (YYYY-MM-DD, inclusive). Omit to fetch all history.
        from: "2024-01-01",
        to: "2024-12-31",
      },
    ],

    // Chain name → GeckoTerminal network slug overrides.
    // Merged on top of the built-in defaults.
    // Default: {}
    chain_slugs: {
      mychain: "my-gt-slug",
    },

    // TTL in seconds for the pool address cache.
    // Default: 604800 (7 days)
    pool_cache_ttl_seconds: 604800,

    // Maximum API requests per minute.
    // Default: 28
    rate_per_minute: 28,
  },
},
```

Config keys:

| Key | Type | Default | Description |
|---|---|---|---|
| `targets` | `GeckoTerminalTarget[]` (min 1) | — | Pools to fetch (required) |
| `chain_slugs` | `Record<string, string>` | `{}` | Additional or override chain → GeckoTerminal slug mappings |
| `pool_cache_ttl_seconds` | `number` (int, > 0) | `604800` | TTL for pool address cache entries |
| `rate_per_minute` | `number` (int, > 0) | `28` | API request rate limit |

`GeckoTerminalTarget` fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `symbol` | `string` | yes | Ticker symbol as used in the ledger |
| `chain` | `string` | yes | Chain name (key into `chain_slugs`) |
| `contract` | `string` (0x EVM address) | yes | Token contract address |
| `from` | `string` (YYYY-MM-DD) | no | Start of date range; omit for full history |
| `to` | `string` (YYYY-MM-DD) | no | End of date range; omit to default to today |

Built-in `chain_slugs` defaults: `ethereum→eth`, `base→base`,
`optimism→optimism`, `arbitrum→arbitrum`, `polygon→polygon_pos`,
`avalanche→avax`, `scroll→scroll`, `unichain→unichain`, `zora→zora`.

### Gotchas

- GeckoTerminal's free tier is rate-limited to roughly 30 requests per
  minute. The default `rate_per_minute: 28` is tuned to stay under this.
  Do not raise it without a paid plan.
- The parser selects the highest-liquidity pool for each `(chain, contract)`
  pair automatically. If a pool is delisted, the cached pool address is
  invalidated and re-resolved on the next sync (one retry per sync run).
- Chains not present in `chain_slugs` (or the built-in defaults) are
  silently skipped. If a target produces no output, verify that its
  `chain` value matches a key in the slug map.
- `contract` must be a 0x-prefixed 40-hex-character EVM address. The
  parser validates this at config parse time.
