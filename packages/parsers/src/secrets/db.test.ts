import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { DbSecretResolver } from "./db";
import { EnvSecretResolver } from "./env";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE provider_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)`);
});
afterEach(() => db.close());

test("returns the DB value when present", async () => {
  db.run("INSERT INTO provider_secrets (name, value) VALUES ('ZERION_API_KEY','zk_db')");
  const r = new DbSecretResolver(db, new EnvSecretResolver());
  expect(await r.get("ZERION_API_KEY")).toBe("zk_db");
});

test("falls back to env when no DB row", async () => {
  process.env.TEST_FALLBACK_KEY = "from_env";
  const r = new DbSecretResolver(db, new EnvSecretResolver());
  expect(await r.get("TEST_FALLBACK_KEY")).toBe("from_env");
  delete process.env.TEST_FALLBACK_KEY;
});

test("returns null when neither DB nor fallback has it", async () => {
  const r = new DbSecretResolver(db, new EnvSecretResolver());
  expect(await r.get("DEFINITELY_MISSING_KEY")).toBeNull();
});

test("empty DB value falls through to fallback", async () => {
  db.run("INSERT INTO provider_secrets (name, value) VALUES ('K','')");
  process.env.K = "env_val";
  const r = new DbSecretResolver(db, new EnvSecretResolver());
  expect(await r.get("K")).toBe("env_val");
  delete process.env.K;
});
