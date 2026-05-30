import { z } from "zod";

export const ZerionConfig = z.object({
  // Name of the env var holding the Zerion API key. The actual secret
  // value is resolved at runtime via ctx.secrets.get(api_key_env).
  api_key_env: z.string().default("ZERION_API_KEY"),

  // Zerion v1 base URL. Overridable for tests / regional mirrors.
  base_url: z.string().url().default("https://api.zerion.io/v1"),

  // EVM wallet addresses to sync. Empty array → parser short-circuits
  // (zero ops, zero warnings). Case is preserved at config layer;
  // the parser lowercases internally where stable identifiers matter.
  wallets: z.array(
    z.string().regex(/^0x[a-fA-F0-9]{40}$/, "EVM address required"),
  ).default([]),

  // Phase-1 filter: positions where attributes.value < min_value_usd
  // are dropped before chain grouping. Default $1.00 matches the
  // Python predecessor.
  min_value_usd: z.number().nonnegative().default(1.0),

  // TTL applied to both wallet-chart and fungible-chart cache entries
  // in ctx.cache. Default 86400 = 24h.
  chart_cache_ttl_seconds: z.number().int().positive().default(86400),
}).strict();

export type ZerionConfig = z.infer<typeof ZerionConfig>;
