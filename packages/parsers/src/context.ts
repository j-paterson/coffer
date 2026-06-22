import { ConsoleLogger } from "./types/logger";
import { InMemoryParserCache } from "./types/cache";
import { EnvSecretResolver } from "./secrets/env";
import { makeFetchJson } from "./http/fetch-json";
import { DEFAULT_RETRY, type RetryPolicy } from "./types/http";
import { NullPriceProvider } from "./types/price-provider";
import type { ParserContext } from "./types/parser";
import type { Logger } from "./types/logger";
import type { ParserCache } from "./types/cache";
import type { SecretResolver } from "./types/secrets";
import type { PriceProvider } from "./types/price-provider";

export interface BuildContextOpts<C> {
  config: C;
  http?: typeof fetch;
  cache?: ParserCache;
  logger?: Logger;
  secrets?: SecretResolver;
  now?: () => Date;
  retry?: Partial<RetryPolicy>;
  priceProvider?: PriceProvider;
}

export function buildContext<C>(opts: BuildContextOpts<C>): ParserContext<C> {
  const http = opts.http ?? globalThis.fetch;
  const logger = opts.logger ?? new ConsoleLogger();
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...opts.retry };
  return {
    config: opts.config,
    http,
    fetchJson: makeFetchJson(http, logger, policy),
    cache: opts.cache ?? new InMemoryParserCache(),
    logger,
    secrets: opts.secrets ?? new EnvSecretResolver(),
    now: opts.now ?? (() => new Date()),
    priceProvider: opts.priceProvider ?? new NullPriceProvider(),
  };
}
