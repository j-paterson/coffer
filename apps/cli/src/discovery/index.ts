import type { Database } from "bun:sqlite";
import type { ParserId } from "@coffer/config";
import { discoverDefillama } from "./defillama";
import { discoverGeckoterminal } from "./geckoterminal";

export function runDiscovery(parserId: ParserId, db: Database): Record<string, unknown> {
  switch (parserId) {
    case "defillama":     return discoverDefillama(db);
    case "geckoterminal": return discoverGeckoterminal(db);
    default:              return {};
  }
}
