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
  walker?: WalkerConfigInput;
};

/** Walker tuning knobs accepted in finance.config.ts.
 *
 *  `assetOnlyTypes` is a plain string[] here (JSON-serialisable); the
 *  server converts it to a Set<string> when building the LedgerCtx. */
export interface WalkerConfigInput {
  /** ISO date (YYYY-MM-DD, inclusive). History before this date is
   *  excluded from the net-worth and MTM series. Omit to include all
   *  history (the correct default for most users). */
  networthFloor?: string;
  /** Account types whose negative reconstructed balances are clamped to
   *  zero (e.g. ["crypto", "brokerage"]). Omit to use the walker's built-in
   *  defaults. Pass an empty array to disable clamping entirely. */
  assetOnlyTypes?: string[];
}

export function defineConfig(c: FinanceConfigInput): FinanceConfigInput {
  return c;
}
