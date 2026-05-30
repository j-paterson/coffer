import { z } from "zod";

export const DEFAULT_CHAIN_MAP: Record<string, string> = {
  BTC:   "bitcoin",
  ETH:   "ethereum",
  USDC:  "ethereum",
  USDT:  "ethereum",
  SOL:   "solana",
  MATIC: "polygon",
  AVAX:  "avalanche",
  LINK:  "ethereum",
  DAI:   "ethereum",
  LTC:   "litecoin",
};

export const CoinbaseConfig = z.object({
  key_name_env:               z.string().default("COINBASE_KEY_NAME"),
  private_key_env:            z.string().default("COINBASE_PRIVATE_KEY"),
  rate_per_minute:            z.number().int().positive().default(1500),
  accounts_cache_ttl_seconds: z.number().int().nonnegative().default(300),
  chain_map:                  z.record(z.string(), z.string()).default({}),
}).strict();

export type CoinbaseConfig = z.infer<typeof CoinbaseConfig>;
