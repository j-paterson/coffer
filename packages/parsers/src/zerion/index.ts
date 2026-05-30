import type { Parser } from "../types/parser";
import { ZerionConfig as ZerionConfigSchema } from "./config";
import type { ZerionConfig } from "./config";
import { syncZerion } from "./parse";

export const zerionParser: Parser<ZerionConfig> = {
  id: "zerion",
  name: "Zerion",
  capabilities: ["accounts", "positions", "balances", "prices"],
  configSchema: ZerionConfigSchema,
  sync: syncZerion,
};
