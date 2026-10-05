import { describe, expect, test, vi } from "vitest";
import { SyncTriggerError } from "./api";
import { describeSyncAll, runSyncAll, SYNC_ALL_ORDER, type ParserId } from "./syncAll";

const ok = (id: string) => () => Promise.resolve({ run_id: `run-${id}` });
const triggers = (over: Partial<Record<ParserId, () => Promise<{ run_id: string }>>> = {}) =>
  Object.fromEntries(SYNC_ALL_ORDER.map((id) => [id, over[id] ?? ok(id)])) as Record<
    ParserId,
    () => Promise<{ run_id: string }>
  >;

describe("runSyncAll", () => {
  test("runs every parser in order and waits for each", async () => {
    const wait = vi.fn((_runId: string) => Promise.resolve());
    const out = await runSyncAll(triggers(), wait);
    expect(out.completed).toEqual([...SYNC_ALL_ORDER]);
    expect(wait.mock.calls.map((c) => c[0])).toEqual(SYNC_ALL_ORDER.map((id) => `run-${id}`));
  });

  test("a SimpleFIN cooldown is skipped and the rest still run", async () => {
    const out = await runSyncAll(
      triggers({ simplefin: () => Promise.reject(new SyncTriggerError("SimpleFIN cooldown active", 429, 3600)) }),
      () => Promise.resolve(),
    );
    expect(out.skipped).toEqual([{ id: "simplefin", retryAfterSeconds: 3600 }]);
    expect(out.completed).toEqual(SYNC_ALL_ORDER.filter((id) => id !== "simplefin"));
    expect(out.failed).toEqual([]);
  });

  test("other refusals are reported as failures without aborting", async () => {
    const out = await runSyncAll(
      triggers({ zerion: () => Promise.reject(new SyncTriggerError("different sync already in progress", 409, null)) }),
      () => Promise.resolve(),
    );
    expect(out.failed).toEqual([{ id: "zerion", message: "different sync already in progress" }]);
    expect(out.completed).toHaveLength(SYNC_ALL_ORDER.length - 1);
  });
});

describe("describeSyncAll", () => {
  test("null when everything ran", () => {
    expect(describeSyncAll({ completed: [...SYNC_ALL_ORDER], skipped: [], failed: [] })).toBeNull();
  });

  test("names skipped and failed parsers", () => {
    const msg = describeSyncAll({
      completed: [],
      skipped: [{ id: "simplefin", retryAfterSeconds: null }],
      failed: [{ id: "coinbase", message: "Missing key" }],
    });
    expect(msg).toBe("SimpleFIN skipped (cooldown) · Coinbase failed: Missing key");
  });

  test("includes the retry time when known", () => {
    const msg = describeSyncAll(
      { completed: [], skipped: [{ id: "simplefin", retryAfterSeconds: 60 }], failed: [] },
      new Date(2026, 0, 1, 2, 59).getTime(),
    );
    expect(msg).toBe("SimpleFIN skipped (cooldown until 3:00 AM)");
  });
});
