import { z } from "zod";

export const DEFAULT_CHAIN_SLUGS: Record<string, string> = {
  ethereum:  "eth",
  base:      "base",
  optimism:  "optimism",
  arbitrum:  "arbitrum",
  polygon:   "polygon_pos",
  avalanche: "avax",
  scroll:    "scroll",
  unichain:  "unichain",
  zora:      "zora",
};

export const GeckoTerminalTarget = z.object({
  symbol:   z.string().min(1),
  chain:    z.string().min(1),
  contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  from:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export type GeckoTerminalTarget = z.infer<typeof GeckoTerminalTarget>;

export const GeckoTerminalConfig = z.object({
  targets:                z.array(GeckoTerminalTarget).min(1),
  chain_slugs:            z.record(z.string(), z.string()).default({}),
  pool_cache_ttl_seconds: z.number().int().positive().default(604_800),
  rate_per_minute:        z.number().int().positive().default(28),
}).strict();

export type GeckoTerminalConfig = z.infer<typeof GeckoTerminalConfig>;
