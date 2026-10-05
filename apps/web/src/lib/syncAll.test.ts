import { describe, expect, test } from "vitest";
import type { SyncAllState, SyncAllStep } from "../../../../packages/shared/types";
import { describeSyncAll } from "./syncAll";

const IDS: SyncAllStep["id"][] = ["simplefin", "defillama", "zerion", "alchemy", "geckoterminal", "coinbase"];
const state = (over: Partial<Record<SyncAllStep["id"], Partial<SyncAllStep>>>, finished = true): SyncAllState => ({
  id: "c1",
  started_at: new Date(2026, 0, 1, 14, 59).toISOString(),
  finished_at: finished ? new Date(2026, 0, 1, 15, 2).toISOString() : null,
  steps: IDS.map((id) => ({ id, status: finished ? "completed" : "pending", ...over[id] })),
});

describe("describeSyncAll", () => {
  test("null when everything ran", () => {
    expect(describeSyncAll(state({}))).toBeNull();
  });

  test("names skipped and failed parsers with the retry time", () => {
    const msg = describeSyncAll(
      state({
        simplefin: { status: "skipped", retry_at: new Date(2026, 0, 1, 3, 0).toISOString() },
        coinbase: { status: "failed", message: "Missing key" },
      }),
    );
    expect(msg).toBe("Sync all at 2:59 PM: SimpleFIN skipped (cooldown until 3:00 AM) · Coinbase failed: Missing key");
  });

  test("shows progress, and skips so far, while running", () => {
    const msg = describeSyncAll(
      state({ simplefin: { status: "skipped" }, defillama: { status: "completed" }, zerion: { status: "running" } }, false),
    );
    expect(msg).toBe("Syncing Zerion (3/6)… · SimpleFIN skipped (cooldown)");
  });
});
