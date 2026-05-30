import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "@coffer/ledger/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, mkdtempSync, writeFileSync } from "node:fs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../../db/migrations");
const ENTRY = resolve(HERE, "../src/index.ts");

function seedEmptyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "phase4-integration-"));
  const path = join(dir, "finance.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS_DIR);
  db.close();
  return path;
}

async function readAll(stream: ReadableStream<Uint8Array> | undefined | null): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged);
}

describe("integration — argv rejection", () => {
  test("unknown parser id exits 2 with usage on stderr", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", ENTRY, "sync", "nope"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([readAll(proc.stderr), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown parser id");
    expect(stderr).toContain("Usage:");
  });
});

describe("integration — SKIP path (geckoterminal, empty DB, no config file)", () => {
  let dbPath: string;
  beforeEach(() => { dbPath = seedEmptyDb(); });
  afterEach(()  => { try { unlinkSync(dbPath); } catch {} });

  test("exits 0, prints 'no eligible targets', emits sync_started + sync_finished{ok:true}", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", ENTRY, "sync", "geckoterminal", "--events-fd", "3",
            "--config", "/tmp/does-not-exist-phase4.ts"],
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: { ...process.env, FINANCE_DB: dbPath },
    });
    const fd3Num = (proc as unknown as { stdio: (number | null)[] }).stdio[3] as number;
    const [stdout, stderr, exitCode] = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
      proc.exited,
    ]);
    const fd3Out = await Bun.file(fd3Num).text();
    if (exitCode !== 0) {
      throw new Error(`exit=${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\nFD3:\n${fd3Out}`);
    }
    expect(stdout).toContain("no eligible targets");
    const events = fd3Out.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e: { type: string }) => e.type)).toEqual(["sync_started", "sync_finished"]);
    expect((events[1] as { ok: boolean }).ok).toBe(true);
    expect((events[1] as { totals: Record<string, unknown> }).totals.geckoterminal).toBeDefined();
  });
});

describe("integration — ConfigParseError exits 2", () => {
  let dbPath: string;
  let badConfigPath: string;
  beforeEach(() => {
    dbPath = seedEmptyDb();
    badConfigPath = join(mkdtempSync(join(tmpdir(), "phase4-bad-config-")), "finance.config.ts");
    writeFileSync(
      badConfigPath,
      `import { defineConfig } from "@coffer/config";\n` +
      `export default { parsers: { simplefin: { lookback_days: "not a number" } } };\n`,
    );
  });
  afterEach(() => {
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(badConfigPath); } catch {}
  });

  test("invalid simplefin config exits 2 with stderr describing the failure", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", ENTRY, "sync", "simplefin", "--config", badConfigPath],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FINANCE_DB: dbPath },
    });
    const [stderr, exitCode] = await Promise.all([readAll(proc.stderr), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("simplefin");
    expect(stderr.toLowerCase()).toContain("invalid");
  });
});

describe("integration — DB open failure", () => {
  test("missing FINANCE_DB target exits 1 with 'cannot open database' on stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase4-missing-db-"));
    const path = join(dir, "does-not-exist.sqlite");
    const proc = Bun.spawn({
      cmd: ["bun", ENTRY, "sync", "coinbase",
            "--config", "/tmp/does-not-exist-phase4.ts"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FINANCE_DB: path },
    });
    const [stderr, exitCode] = await Promise.all([readAll(proc.stderr), proc.exited]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot open database");
  });
});
