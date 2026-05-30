// Phase 1 surface (unchanged)
export type { Capability, Parser, ParserContext } from "./types/parser";
export type { ParserCache } from "./types/cache";
export { InMemoryParserCache } from "./types/cache";
export type { Logger, ConsoleSink } from "./types/logger";
export { ConsoleLogger } from "./types/logger";
export { manualCsvParser } from "./manual-csv";
export { ManualCsvConfig } from "./manual-csv/config";
export type { ManualCsvConfig as ManualCsvConfigType } from "./manual-csv/config";

// Phase 2.0 — HTTP
export type { FetchJson, FetchJsonOpts, RetryPolicy } from "./types/http";
export { DEFAULT_RETRY } from "./types/http";
export {
  ParserHttpError,
  HttpStatusError,
  HttpNetworkError,
} from "./http/errors";

// Phase 2.0 — Cache
export { SqliteParserCache } from "./cache/sqlite";

// Phase 2.0 — Secrets
export type { SecretResolver } from "./types/secrets";
export { EnvSecretResolver } from "./secrets/env";

// Phase 2.0 — Pagination
export { paginate } from "./util/paginate";
export type { PageAdapter } from "./util/paginate";

// Phase 2.0 — Context
export { buildContext } from "./context";
export type { BuildContextOpts } from "./context";

// Phase 2.1.1 — SimpleFIN
export { simpleFinParser } from "./simplefin";
export { SimpleFinConfig } from "./simplefin/config";
export type { SimpleFinConfig as SimpleFinConfigType } from "./simplefin/config";

// Phase 2.1.2 — DefiLlama
export { defiLlamaParser } from "./defillama";
export { DefiLlamaConfig } from "./defillama/config";
export type { DefiLlamaConfig as DefiLlamaConfigType } from "./defillama/config";

// Phase 2.1.3 — Zerion
export { zerionParser } from "./zerion";
export { ZerionConfig } from "./zerion/config";
export type { ZerionConfig as ZerionConfigType } from "./zerion/config";

// Phase 2.1.4 — Alchemy
export { alchemyParser } from "./alchemy";
export { AlchemyConfig } from "./alchemy/config";
export type { AlchemyConfig as AlchemyConfigType } from "./alchemy/config";

// Phase 2.1.5 — GeckoTerminal
export { geckoTerminalParser } from "./geckoterminal";
export { GeckoTerminalConfig } from "./geckoterminal/config";
export type { GeckoTerminalConfig as GeckoTerminalConfigType } from "./geckoterminal/config";

// Phase 2.1.6 — PriceProvider types (for LedgerPriceProvider in @coffer/ledger)
export type { PriceProvider, PriceLookup, PriceProviderArgs } from "./types/price-provider";
export { NullPriceProvider, MapPriceProvider } from "./types/price-provider";

// Phase 2.1.6 — Coinbase
export { coinbaseParser } from "./coinbase";
export { CoinbaseConfig } from "./coinbase/config";
export type { CoinbaseConfig as CoinbaseConfigType } from "./coinbase/config";
