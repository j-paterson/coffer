import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations } from "@coffer/ledger/schema";
import { SyncRunCoordinator } from "../src/lib/syncRuns";
import type { SyncEvent } from "../../../packages/shared/types";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../db/migrations");

describe("cliSpawn.e2e — real CLI subprocess against temp DB", () => {
  test("defillama with empty discovery emits sync_started + sync_finished, exits 0", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "finance-e2e-"));
    const dbPath = join(tmpDir, "finance.sqlite");
    const cachePath = join(tmpDir, "parser-cache.sqlite");
    const configPath = join(tmpDir, "finance.config.ts");

    const db = new Database(dbPath);
    applyMigrations(db, MIGRATIONS_DIR);
    db.close();

    // Note: we export a plain object rather than wrapping in defineConfig().
    // Bun resolves @coffer/config relative to the importing *file*'s location,
    // not process.cwd(); since configPath is in /tmp the workspace package is
    // not reachable. defineConfig is identity so the plain-object form is
    // semantically equivalent and avoids the resolution dead-end.
    writeFileSync(
      configPath,
      `export default { parsers: { defillama: {} } };\n`,
    );

    const coord = new SyncRunCoordinator({
      cliEntry: CLI_ENTRY,
      configPath,
    });

    const prevDb = process.env.FINANCE_DB;
    const prevCache = process.env.FINANCE_PARSER_CACHE;
    process.env.FINANCE_DB = dbPath;
    process.env.FINANCE_PARSER_CACHE = cachePath;

    const received: SyncEvent[] = [];
    const unsub = coord.subscribe((e) => received.push(e));

    try {
      const result = coord.startRun("defillama", []);
      expect(result).not.toBeNull();

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (coord.snapshot().current === null) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(coord.snapshot().current).toBeNull();

      const types = received.map((e) => e.type);
      expect(types.filter((t) => t === "sync_started")).toHaveLength(1);
      expect(types[types.length - 1]).toBe("sync_finished");

      const history = coord.snapshot().history;
      expect(history.length).toBe(1);
      expect(history[0].ok).toBe(true);

      const verifyDb = new Database(dbPath, { readonly: true });
      const txnCount = verifyDb
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM transactions_v2")
        .get()!.n;
      expect(txnCount).toBe(0);
      verifyDb.close();
    } finally {
      unsub();
      if (prevDb === undefined) delete process.env.FINANCE_DB;
      else process.env.FINANCE_DB = prevDb;
      if (prevCache === undefined) delete process.env.FINANCE_PARSER_CACHE;
      else process.env.FINANCE_PARSER_CACHE = prevCache;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
