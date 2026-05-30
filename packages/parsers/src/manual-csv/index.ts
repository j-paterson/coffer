import type { Parser } from "../types/parser";
import { ManualCsvConfig as ManualCsvConfigSchema } from "./config";
import type { ManualCsvConfig } from "./config";
import { syncManualCsv } from "./parse";

export const manualCsvParser: Parser<ManualCsvConfig> = {
  id: "manual-csv",
  name: "Manual CSV",
  capabilities: ["transactions", "accounts"],
  configSchema: ManualCsvConfigSchema,
  sync: syncManualCsv,
};
