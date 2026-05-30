import { z } from "zod";

export const DefiLlamaTarget = z.object({
  symbol: z.string().min(1),
  chain: z.string().nullable().default(null),
  contract: z.string().nullable().default(null),
  // Resume cursor (inclusive). Orchestrator sets to (MAX(as_of) + 1 day)
  // for incremental sync, or earliest known position date for backfill.
  // Null falls back to floor_date.
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});
export type DefiLlamaTarget = z.infer<typeof DefiLlamaTarget>;

export const DefiLlamaConfig = z.object({
  // Asset triples to price. Empty → parser yields no ops (legitimate
  // "no crypto positions yet" state — not a warning).
  targets: z.array(DefiLlamaTarget).default([]),

  // Symbol → coingecko-id overrides. Merged on top of the parser's
  // 31-entry default; override keys are case-normalized to uppercase
  // by mergeCgMap. Set a value to null to suppress the default mapping
  // (e.g. { ETH: null } → unresolved when no chain+contract).
  cg_overrides: z.record(z.string(), z.string().nullable()).default({}),

  // Used when a target's `since` is null. ISO date, inclusive.
  floor_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2017-01-01"),

  // Coin keys known to return no data — skipped to avoid wasted API calls.
  // Populated automatically from the price_source_misses table; 30-day TTL.
  skip_coin_keys: z.array(z.string()).default([]),

  // Override for tests + alternative DefiLlama mirrors.
  base_url: z.string().url().default("https://coins.llama.fi"),
});
export type DefiLlamaConfig = z.infer<typeof DefiLlamaConfig>;
