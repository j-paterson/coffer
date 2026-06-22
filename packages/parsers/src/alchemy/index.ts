import type { Parser } from "../types/parser";
import { AlchemyConfig as AlchemyConfigSchema } from "./config";
import type { AlchemyConfig } from "./config";
import { syncAlchemy } from "./parse";

export const alchemyParser: Parser<AlchemyConfig> = {
  id: "alchemy",
  name: "Alchemy",
  capabilities: ["accounts", "positions"],
  configSchema: AlchemyConfigSchema,
  sync: syncAlchemy,
};
