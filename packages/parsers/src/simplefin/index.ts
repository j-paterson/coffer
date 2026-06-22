import type { Parser } from "../types/parser";
import { SimpleFinConfig as SimpleFinConfigSchema } from "./config";
import type { SimpleFinConfig } from "./config";
import { syncSimpleFin } from "./parse";

export const simpleFinParser: Parser<SimpleFinConfig> = {
  id: "simplefin",
  name: "SimpleFIN",
  capabilities: ["transactions", "balances", "positions", "accounts"],
  configSchema: SimpleFinConfigSchema,
  sync: syncSimpleFin,
};
