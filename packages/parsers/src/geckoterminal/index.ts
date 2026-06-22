import type { Parser } from "../types/parser";
import { GeckoTerminalConfig as GeckoTerminalConfigSchema } from "./config";
import type { GeckoTerminalConfig } from "./config";
import { syncGeckoTerminal } from "./parse";

export const geckoTerminalParser: Parser<GeckoTerminalConfig> = {
  id: "geckoterminal",
  name: "GeckoTerminal",
  capabilities: ["prices"],
  configSchema: GeckoTerminalConfigSchema,
  sync: syncGeckoTerminal,
};
