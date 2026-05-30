// dashboard/api/test/syncRuns.test.ts
import { describe, expect, test } from "bun:test";
import { SyncRunCoordinator } from "../src/lib/syncRuns";
import type { SyncEvent } from "../../../packages/shared/types";

const evt = (partial: Partial<SyncEvent> & { type: SyncEvent["type"] }): SyncEvent =>
  ({ ts: "2026-04-27T00:00:00Z", seq: 0, run_id: "r1", ...partial } as SyncEvent);

describe("SyncRunCoordinator", () => {
  test("startRun creates a current run and is reflected in snapshot", () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    const { run_id } = c._startRunForTest(["simplefin"]);
    const snap = c.snapshot();
    expect(snap.current?.run_id).toBe(run_id);
    expect(snap.current?.finished_at).toBeNull();
    expect(snap.history).toEqual([]);
  });

  test("subscribers receive replayed events first, then live", () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    c._startRunForTest(["simplefin"]);
    c._inject(evt({ type: "account_started", account_id: "ACT-1", source: "simplefin" } as any));
    const received: SyncEvent[] = [];
    const unsub = c.subscribe((e) => received.push(e));
    expect(received.map((e) => e.type)).toEqual(["sync_started", "account_started"]);
    c._inject(evt({ type: "account_finished", account_id: "ACT-1", ok: true } as any));
    expect(received.map((e) => e.type)).toEqual([
      "sync_started", "account_started", "account_finished",
    ]);
    unsub();
  });

  test("finalize rotates current to history and synthesizes account_finished for any still-active accounts", () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    c._startRunForTest(["simplefin"]);
    c._inject(evt({ type: "account_started", account_id: "ACT-1", source: "simplefin" } as any));
    // Note: never finished ACT-1.
    c._finalizeForTest({ exitCode: 1 });
    const snap = c.snapshot();
    expect(snap.current).toBeNull();
    expect(snap.history.length).toBe(1);
    const types = snap.history[0].events.map((e) => e.type);
    // Synthesized: account_finished (ok=false), sync_finished (ok=false).
    expect(types).toContain("account_finished");
    expect(types[types.length - 1]).toBe("sync_finished");
    const last = snap.history[0].events[snap.history[0].events.length - 1] as any;
    expect(last.ok).toBe(false);
  });

  test("history bounded at 5 — oldest evicted on 6th run", () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    for (let i = 0; i < 6; i++) {
      c._startRunForTest(["simplefin"]);
      c._finalizeForTest({ exitCode: 0 });
    }
    expect(c.snapshot().history.length).toBe(5);
  });

  test("startRun coalesces same-trigger when run is in flight", () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    const { run_id: a } = c._startRunForTest(["simplefin"], "simplefin");
    const { run_id: b } = c._startRunForTest(["simplefin"], "simplefin");
    expect(a).toBe(b);
  });

  test("startRun returns null for cross-trigger collision", () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    c._startRunForTest(["zerion"], "zerion");
    const result = c._startRunForTest(["simplefin"], "simplefin");
    expect(result).toBeNull();
  });

  test("ring buffer caps events at MAX_EVENTS_PER_RUN", () => {
    const c = new SyncRunCoordinator({ maxEventsPerRun: 3 });
    c._startRunForTest(["simplefin"]);  // emits sync_started → 1 event
    c._inject(evt({ type: "account_started", account_id: "A", source: "simplefin" } as any));
    c._inject(evt({ type: "account_started", account_id: "B", source: "simplefin" } as any));
    c._inject(evt({ type: "account_started", account_id: "C", source: "simplefin" } as any));
    const snap = c.snapshot();
    expect(snap.current!.events.length).toBe(3);
    // Oldest dropped.
    expect(snap.current!.events[0].type).not.toBe("sync_started");
  });

  test("startRun spawns subprocess and pumps events from fake stream", async () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    let writeFn: (line: string) => void;
    let resolveExit: (code: number) => void;
    const fakeSpawn = (_argv: string[]) => ({
      extraFds: [
        {
          readable: new ReadableStream<Uint8Array>({
            start(controller) {
              writeFn = (line: string) =>
                controller.enqueue(new TextEncoder().encode(line));
              (fakeSpawn as any)._end = () => controller.close();
            },
          }),
        },
      ],
      exited: new Promise<number>((r) => { resolveExit = r; }),
    });

    const result = c.startRun("simplefin", ["--days", "30"], { spawn: fakeSpawn });
    expect(result).not.toBeNull();
    writeFn!(JSON.stringify({ type: "account_started", account_id: "ACT-1", source: "simplefin" }) + "\n");
    writeFn!(JSON.stringify({ type: "account_finished", account_id: "ACT-1", ok: true }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    const snap = c.snapshot();
    const types = snap.current!.events.map((e) => e.type);
    expect(types).toContain("account_started");
    expect(types).toContain("account_finished");
    (fakeSpawn as any)._end();
    resolveExit!(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(c.snapshot().current).toBeNull();
    expect(c.snapshot().history.length).toBe(1);
    expect(c.snapshot().history[0].ok).toBe(true);
  });

  test("startRun synthesizes closeouts when subprocess exits non-zero mid-run", async () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    let writeFn: (line: string) => void;
    let resolveExit: (code: number) => void;
    const fakeSpawn = (_argv: string[]) => ({
      extraFds: [
        {
          readable: new ReadableStream<Uint8Array>({
            start(controller) {
              writeFn = (line: string) =>
                controller.enqueue(new TextEncoder().encode(line));
              (fakeSpawn as any)._end = () => controller.close();
            },
          }),
        },
      ],
      exited: new Promise<number>((r) => { resolveExit = r; }),
    });

    c.startRun("simplefin", [], { spawn: fakeSpawn });
    writeFn!(JSON.stringify({ type: "account_started", account_id: "ACT-1", source: "simplefin" }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    (fakeSpawn as any)._end();
    resolveExit!(1);
    await new Promise((r) => setTimeout(r, 5));
    const last = c.snapshot().history[0];
    expect(last.ok).toBe(false);
    const finishedAct1 = last.events.find(
      (e) => e.type === "account_finished" && (e as any).account_id === "ACT-1",
    );
    expect(finishedAct1).toBeDefined();
  });

  test("malformed event lines are dropped, run continues", async () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    let writeFn: (line: string) => void;
    let resolveExit: (code: number) => void;
    const fakeSpawn = (_argv: string[]) => ({
      extraFds: [{
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            writeFn = (line: string) => controller.enqueue(new TextEncoder().encode(line));
            (fakeSpawn as any)._end = () => controller.close();
          },
        }),
      }],
      exited: new Promise<number>((r) => { resolveExit = r; }),
    });
    c.startRun("simplefin", [], { spawn: fakeSpawn });
    writeFn!("this is not json\n");
    writeFn!(JSON.stringify({ type: "account_started", account_id: "ACT-1", source: "simplefin" }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    const types = c.snapshot().current!.events.map((e) => e.type);
    expect(types).toContain("account_started");
    (fakeSpawn as any)._end();
    resolveExit!(0);
  });

  test("startRun with throwing spawn finalizes the run cleanly", async () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    const throwingSpawn = (_argv: string[]): any => {
      throw new Error("simulated ENOENT");
    };
    const result = c.startRun("simplefin", [], { spawn: throwingSpawn });
    expect(result).toBeNull();
    expect(c.snapshot().current).toBeNull();
    expect(c.snapshot().history.length).toBe(1);
    expect(c.snapshot().history[0].ok).toBe(false);
  });

  test("startRun coalesces second invocation by spawned flag, not event count", async () => {
    const c = new SyncRunCoordinator({ maxEventsPerRun: 1 });
    let writeFn1: (line: string) => void;
    let resolveExit1: (code: number) => void;
    let spawnCount = 0;
    const fakeSpawn = (_argv: string[]) => {
      spawnCount++;
      return {
        extraFds: [{
          readable: new ReadableStream<Uint8Array>({
            start(controller) {
              writeFn1 = (line: string) => controller.enqueue(new TextEncoder().encode(line));
              (fakeSpawn as any)._end = () => controller.close();
            },
          }),
        }],
        exited: new Promise<number>((r) => { resolveExit1 = r; }),
      };
    };
    c.startRun("simplefin", [], { spawn: fakeSpawn });
    // Push enough events to overflow the 1-event ring buffer.
    writeFn1!(JSON.stringify({ type: "account_started", account_id: "A", source: "simplefin" }) + "\n");
    writeFn1!(JSON.stringify({ type: "account_started", account_id: "B", source: "simplefin" }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    // Second startRun should still coalesce, not respawn.
    const second = c.startRun("simplefin", [], { spawn: fakeSpawn });
    expect(second).not.toBeNull();
    expect(spawnCount).toBe(1);
    (fakeSpawn as any)._end();
    resolveExit1!(0);
    await new Promise((r) => setTimeout(r, 5));
  });

  test("startRun spawns the TS CLI with the expected argv", () => {
    const c = new SyncRunCoordinator({
      cliEntry: "/abs/cli/index.ts",
      configPath: "/abs/finance.config.ts",
    });
    let captured: string[] = [];
    const fakeSpawn = (argv: string[]) => {
      captured = argv;
      return {
        extraFds: [{
          readable: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        }],
        exited: Promise.resolve(0),
      };
    };
    c.startRun("simplefin", ["--days", "30"], { spawn: fakeSpawn });
    expect(captured).toEqual([
      "bun", "/abs/cli/index.ts",
      "sync", "simplefin",
      "--config", "/abs/finance.config.ts",
      "--events-fd", "3",
      "--days", "30",
    ]);
  });

  test("startRun passes [trigger] as sources, not a hardcoded multi-parser list", () => {
    const c = new SyncRunCoordinator({ postSyncHooks: false });
    c._startRunForTest(["defillama"], "defillama");
    const snap = c.snapshot();
    const sync_started = snap.current!.events.find((e) => e.type === "sync_started")!;
    expect((sync_started as any).sources).toEqual(["defillama"]);
  });
});
