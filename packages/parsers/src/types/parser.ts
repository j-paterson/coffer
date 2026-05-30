import type { ZodType, ZodTypeDef } from "zod";
import type { Operation } from "@coffer/ledger/runner";
import type { ParserCache } from "./cache";
import type { Logger } from "./logger";
import type { FetchJson } from "./http";
import type { SecretResolver } from "./secrets";
import type { PriceProvider } from "./price-provider";

export type Capability =
  | "transactions"
  | "balances"
  | "positions"
  | "prices"
  | "accounts";

export interface ParserContext<C> {
  config: C;
  http: typeof fetch;
  fetchJson: FetchJson;
  cache: ParserCache;
  logger: Logger;
  secrets: SecretResolver;
  now: () => Date;
  priceProvider: PriceProvider;
}

export interface Parser<Config = unknown> {
  id: string;
  name: string;
  capabilities: Capability[];
  configSchema: ZodType<Config, ZodTypeDef, unknown>;
  sync(ctx: ParserContext<Config>): AsyncIterable<Operation>;
}
