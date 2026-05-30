import type { Database } from "bun:sqlite";

/** Optional tuning knobs for the walker. All fields are optional;
 *  omitting the entire object (or any field) gives the open behaviour
 *  with no floor / no cap. */
export interface WalkerConfig {
  /** ISO date (inclusive). Dates strictly before this value are
   *  excluded from both the MTM and postings-cumulative series.
   *  Leave undefined to include all history. */
  networthFloor?: string;
  /** Override the set of account types whose negative reconstructed
   *  balances are clamped to zero. Defaults to DEFAULT_ASSET_ONLY_TYPES
   *  (crypto, brokerage, retirement, alt, real_estate, savings).
   *  Pass an empty Set to disable clamping entirely. */
  assetOnlyTypes?: Set<string>;
}

/** Minimum context the walker needs. apps/server/src/ctx.ts:Ctx
 *  extends this so existing route handlers continue to compile. */
export interface LedgerCtx {
  db: Database;
  /** ISO-date "today". Production reads from system clock at startup;
   *  tests pin it to a fixture's as_of. */
  today: string;
  /** Optional walker tuning — floor dates, caps, etc. */
  walkerConfig?: WalkerConfig;
}
