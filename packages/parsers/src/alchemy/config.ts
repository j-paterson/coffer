import { z } from "zod";
import { SUPPORTED_CHAINS } from "./chains";

export const AlchemyConfig = z.object({
  // Env var name holding the Alchemy API key. Secret value resolved at
  // runtime via ctx.secrets.get(api_key_env).
  api_key_env: z.string().default("ALCHEMY_API_KEY"),

  // EVM wallet addresses to sync. Empty array → parser short-circuits
  // (zero ops, zero warnings). Case preserved at config layer; the
  // parser lowercases internally where stable identifiers matter.
  wallets: z.array(
    z.string().regex(/^0x[a-fA-F0-9]{40}$/, "EVM address required"),
  ).default([]),

  // Subset of supported chains to query. Defaults to all 5.
  chains: z.array(z.enum(SUPPORTED_CHAINS)).default([...SUPPORTED_CHAINS]),

  // TTL for alchemy_getTokenMetadata cache entries in ctx.cache.
  // 30 days because (chain, contract) → (symbol, decimals) is immutable.
  metadata_cache_ttl_seconds: z.number().int().positive().default(2592000),
}).strict();

export type AlchemyConfig = z.infer<typeof AlchemyConfig>;
