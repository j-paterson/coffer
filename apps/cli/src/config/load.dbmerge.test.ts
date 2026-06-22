// apps/cli/src/config/load.dbmerge.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { loadParserConfig } from "./load";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE provider_connections (parser_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', status TEXT, last_connected_at TEXT)`);
});
afterEach(() => db.close());

test("merges provider_connections.config_json into parser config", async () => {
  const addr = "0x" + "a".repeat(40);
  db.run("INSERT INTO provider_connections (parser_id, config_json) VALUES ('zerion', ?)", [JSON.stringify({ wallets: [addr] })]);
  const cfg = (await loadParserConfig({ path: "/nonexistent/finance.config.ts", parserId: "zerion", db })) as { wallets: string[] };
  expect(cfg.wallets).toContain(addr);
});
