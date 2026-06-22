import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveDbPath, resolveCachePath, openProductionDb } from "../src/db";

const HERE = fileURLToPath(new URL("../src/", import.meta.url));
const REPO_DB_PATH    = resolve(HERE, "../../../db/finance.sqlite");
const REPO_CACHE_PATH = resolve(HERE, "../../../db/parser-cache.sqlite");

describe("resolveDbPath", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.FINANCE_DB; delete process.env.FINANCE_DB; });
  afterEach(()  => { if (saved !== undefined) process.env.FINANCE_DB = saved; });

  test("default path is module-relative <repo>/db/finance.sqlite", () => {
    expect(resolveDbPath()).toBe(REPO_DB_PATH);
  });

  test("FINANCE_DB env var overrides default", () => {
    process.env.FINANCE_DB = "/tmp/custom.sqlite";
    expect(resolveDbPath()).toBe("/tmp/custom.sqlite");
  });
});

describe("resolveCachePath", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.FINANCE_PARSER_CACHE; delete process.env.FINANCE_PARSER_CACHE; });
  afterEach(()  => { if (saved !== undefined) process.env.FINANCE_PARSER_CACHE = saved; });

  test("default path is module-relative <repo>/db/parser-cache.sqlite", () => {
    expect(resolveCachePath()).toBe(REPO_CACHE_PATH);
  });

  test("FINANCE_PARSER_CACHE env var overrides default", () => {
    process.env.FINANCE_PARSER_CACHE = "/tmp/custom-cache.sqlite";
    expect(resolveCachePath()).toBe("/tmp/custom-cache.sqlite");
  });
});

describe("openProductionDb", () => {
  let saved: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    saved = process.env.FINANCE_DB;
    tmpDir = mkdtempSync(join(tmpdir(), "coffer-db-"));
  });
  afterEach(()  => {
    if (saved === undefined) delete process.env.FINANCE_DB;
    else process.env.FINANCE_DB = saved;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates DB file and applies migrations when target doesn't exist", () => {
    const path = join(tmpDir, "fresh.sqlite");
    process.env.FINANCE_DB = path;
    const db = openProductionDb();
    try {
      expect(existsSync(path)).toBe(true);
      const rows = db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      ).all();
      expect(rows.length).toBe(1);
    } finally {
      db.close();
    }
  });

  test("throws when target directory does not exist", () => {
    process.env.FINANCE_DB = "/nonexistent-coffer-test-dir/x.sqlite";
    expect(() => openProductionDb()).toThrow();
  });
});
