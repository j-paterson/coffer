import type { Parser } from "../types/parser";
import { DefiLlamaConfig as DefiLlamaConfigSchema } from "./config";
import type { DefiLlamaConfig } from "./config";
import { syncDefiLlama } from "./parse";

export const defiLlamaParser: Parser<DefiLlamaConfig> = {
  id: "defillama",
  name: "DefiLlama",
  capabilities: ["prices"],
  configSchema: DefiLlamaConfigSchema,
  sync: syncDefiLlama,
};
