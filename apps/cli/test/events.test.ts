import { describe, expect, test } from "bun:test";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEventsEmitter } from "../src/events";

function withTempFd(fn: (fd: number, path: string) => void) {
  const path = join(tmpdir(), `phase3-events-${Math.random().toString(36).slice(2)}.jsonl`);
  const fd = openSync(path, "w");
  try { fn(fd, path); } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(path); } catch {}
  }
}

describe("makeEventsEmitter — no fd", () => {
  test("returns a no-op emitter when fd is undefined", () => {
    const e = makeEventsEmitter(undefined);
    e.syncStarted({ run_id: "r1", sources: ["coinbase"] });
    e.warning({ run_id: "r1", account_id: null, message: "x" });
    e.syncFinished({ run_id: "r1", ok: true, totals: {} });
  });
});

describe("makeEventsEmitter — with fd", () => {
  test("writes one JSON line per call with monotonic seq starting at 0", () => {
    withTempFd((fd, path) => {
      const e = makeEventsEmitter(fd);
      e.syncStarted({ run_id: "r1", sources: ["coinbase"] });
      e.warning({ run_id: "r1", account_id: null, message: "hello" });
      e.syncFinished({ run_id: "r1", ok: true, totals: { coinbase: { raw_events: 1 } } });
      closeSync(fd);

      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines.length).toBe(3);

      const a = JSON.parse(lines[0]!);
      const b = JSON.parse(lines[1]!);
      const c = JSON.parse(lines[2]!);
      expect(a.type).toBe("sync_started");
      expect(a.seq).toBe(0);
      expect(a.run_id).toBe("r1");
      expect(a.sources).toEqual(["coinbase"]);

      expect(b.type).toBe("warning");
      expect(b.seq).toBe(1);
      expect(b.account_id).toBeNull();
      expect(b.message).toBe("hello");

      expect(c.type).toBe("sync_finished");
      expect(c.seq).toBe(2);
      expect(c.ok).toBe(true);
      expect(c.totals).toEqual({ coinbase: { raw_events: 1 } });
    });
  });

  test("each event includes a parseable ISO 8601 ts", () => {
    withTempFd((fd, path) => {
      const e = makeEventsEmitter(fd);
      e.syncStarted({ run_id: "r1", sources: ["coinbase"] });
      closeSync(fd);

      const line = JSON.parse(readFileSync(path, "utf8").trim());
      expect(typeof line.ts).toBe("string");
      const t = Date.parse(line.ts);
      expect(Number.isNaN(t)).toBe(false);
    });
  });

  test("seq counter persists across multiple emitters per fd is NOT required — each emitter starts at 0", () => {
    withTempFd((fd, path) => {
      const e1 = makeEventsEmitter(fd);
      e1.syncStarted({ run_id: "r1", sources: [] });
      const e2 = makeEventsEmitter(fd);
      e2.syncStarted({ run_id: "r2", sources: [] });
      closeSync(fd);

      const [l1, l2] = readFileSync(path, "utf8").trim().split("\n").map((s) => JSON.parse(s));
      expect(l1.seq).toBe(0);
      expect(l2.seq).toBe(0);
    });
  });
});
