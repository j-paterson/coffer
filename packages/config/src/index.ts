import type { z } from "zod";
import {
  SimpleFinConfig,
  DefiLlamaConfig,
  ZerionConfig,
  AlchemyConfig,
  GeckoTerminalConfig,
  CoinbaseConfig,
} from "@coffer/parsers";

export const PARSER_SCHEMAS = {
  simplefin:     SimpleFinConfig,
  defillama:     DefiLlamaConfig,
  zerion:        ZerionConfig,
  alchemy:       AlchemyConfig,
  geckoterminal: GeckoTerminalConfig,
  coinbase:      CoinbaseConfig,
} as const;

export type ParserId = keyof typeof PARSER_SCHEMAS;

export type FinanceConfigInput = {
  parsers?: {
    [K in ParserId]?: z.input<typeof PARSER_SCHEMAS[K]>;
  };
};

export function defineConfig(c: FinanceConfigInput): FinanceConfigInput {
  return c;
}
