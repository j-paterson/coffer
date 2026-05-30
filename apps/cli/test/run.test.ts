import { describe, expect, test, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "@coffer/ledger/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Parser } from "@coffer/parsers";
import type { Operation } from "@coffer/ledger/runner";
import { runSync } from "../src/run";
import { SchemaOutdatedError } from "../src/errors";
import { makeEventsEmitter } from "../src/events";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../../db/migrations");

let savedCacheEnv: string | undefined;
beforeAll(() => { savedCacheEnv = process.env.FINANCE_PARSER_CACHE; process.env.FINANCE_PARSER_CACHE = ":memory:"; });
afterAll(()  => {
  if (savedCacheEnv === undefined) delete process.env.FINANCE_PARSER_CACHE;
  else process.env.FINANCE_PARSER_CACHE = savedCacheEnv;
});

const NULL_SECRETS = { async get() { return null; } };

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}

function withTempFd<T>(fn: (fd: number, path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `phase4-run-${Math.random().toString(36).slice(2)}.jsonl`);
  const fd = openSync(path, "w");
  return fn(fd, path).finally(() => {
    try { closeSync(fd); } catch {}
    try { unlinkSync(path); } catch {}
  });
}

function readEvents(path: string): any[] {
  return readFileSync(path, "utf8").trim().split("\n").map((s) => JSON.parse(s));
}

const HAPPY_CONFIG = z.object({ x: z.number().default(1) });
const fakeParser = (ops: Operation[], throwAt?: number): Parser<z.infer<typeof HAPPY_CONFIG>> => ({
  id: "fake",
  name: "Fake",
  capabilities: ["accounts"],
  configSchema: HAPPY_CONFIG,
  async *sync() {
    let i = 0;
    if (throwAt != null && i === throwAt) throw new Error("boom");
    for (; i < ops.length; i++) {
      yield ops[i]!;
      if (throwAt != null && i + 1 === throwAt) throw new Error("boom");
    }
  },
});

const FIXED_NOW = () => new Date("2026-05-24T00:00:00Z");

describe("runSync — happy path", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("returns ok=true with RunSummary; fd-3 sequence = [sync_started, sync_finished]", async () => {
    await withTempFd(async (fd, path) => {
      const events = makeEventsEmitter(fd);
      const result = await runSync({
        parserId: "fake",
        config: { x: 1 },
        db,
        env: NULL_SECRETS,
        events,
        now: FIXED_NOW,
        genRunId: () => "run-1",
        registry: { fake: fakeParser([]) },
      });
      closeSync(fd);
      expect(result.ok).toBe(true);
      expect(result.run_id).toBe("run-1");
      expect(result.summary.raw_events).toBe(0);

      const ev = readEvents(path);
      expect(ev.map((e) => e.type)).toEqual(["sync_started", "sync_finished"]);
      expect(ev[0].sources).toEqual(["fake"]);
      expect(ev[1].ok).toBe(true);
      expect(ev[1].totals.fake).toBeDefined();
    });
  });

  test("forwards sync_warning ops as fd-3 warning events", async () => {
    await withTempFd(async (fd, path) => {
      const events = makeEventsEmitter(fd);
      const result = await runSync({
        parserId: "fake",
        config: { x: 1 },
        db,
        env: NULL_SECRETS,
        events,
        now: FIXED_NOW,
        genRunId: () => "run-2",
        registry: {
          fake: fakeParser([
            { kind: "sync_warning", warning: { source: "fake", scope: "test", message: "hello world" } },
          ]),
        },
      });
      closeSync(fd);
      expect(result.ok).toBe(true);

      const ev = readEvents(path);
      expect(ev.map((e) => e.type)).toEqual(["sync_started", "warning", "sync_finished"]);
      expect(ev[1].account_id).toBeNull();
      expect(ev[1].message).toBe("hello world");
    });
  });
});

describe("runSync — parser throws mid-stream", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("propagates the error; sync_finished{ok:false} is emitted", async () => {
    await withTempFd(async (fd, path) => {
      const events = makeEventsEmitter(fd);
      await expect(
        runSync({
          parserId: "fake",
          config: { x: 1 },
          db,
          env: NULL_SECRETS,
          events,
          now: FIXED_NOW,
          genRunId: () => "run-3",
          registry: { fake: fakeParser([], 0) },
        }),
      ).rejects.toThrow("boom");
      closeSync(fd);

      const ev = readEvents(path);
      expect(ev.map((e) => e.type)).toEqual(["sync_started", "sync_finished"]);
      expect(ev[1].ok).toBe(false);
    });
  });
});

describe("runSync — schema outdated rewrap", () => {
  test("SQLITE_ERROR 'no such table' from runOperations gets rewrapped as SchemaOutdatedError", async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, MIGRATIONS_DIR);
    db.exec("DROP TABLE raw_events");
    await withTempFd(async (fd) => {
      const events = makeEventsEmitter(fd);
      const writeOp: Operation = {
        kind: "raw_event",
        source: "fake",
        external_id: "ext-1",
        payload: {},
      };
      await expect(
        runSync({
          parserId: "fake",
          config: { x: 1 },
          db,
          env: NULL_SECRETS,
          events,
          now: FIXED_NOW,
          genRunId: () => "run-4",
          registry: { fake: fakeParser([writeOp]) },
        }),
      ).rejects.toBeInstanceOf(SchemaOutdatedError);
      closeSync(fd);
    });
    db.close();
  });
});
