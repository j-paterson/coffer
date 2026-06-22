import type { Parser } from "../types/parser";
import { CoinbaseConfig } from "./config";
import type { CoinbaseConfig as CoinbaseConfigType } from "./config";
import { syncCoinbase } from "./parse";

export const coinbaseParser: Parser<CoinbaseConfigType> = {
  id: "coinbase",
  name: "Coinbase",
  capabilities: ["accounts", "positions"],
  configSchema: CoinbaseConfig,
  sync(ctx) {
    return syncCoinbase(ctx);
  },
};
