import { describe, expect, test } from "vitest";
import { initialState, MAX_EVENTS, MAX_LOG_LINES, reducer } from "./syncStream";
import type { SyncEvent } from "../../../../packages/shared/types";

const evt = (e: Partial<SyncEvent> & { type: SyncEvent["type"] }): SyncEvent =>
  ({ ts: "2026-04-27T00:00:00Z", seq: 0, run_id: "r1", ...e } as SyncEvent);

describe("syncStream reducer", () => {
  test("sync_started resets accounts and sets running", () => {
    const s0 = { ...initialState, accounts: { "ACT-1": { state: "ok", source: "simplefin", log: [] } as any } };
    const s1 = reducer(s0, { type: "event", event: evt({ type: "sync_started", sources: ["simplefin"] } as any) });
    expect(s1.running).toBe(true);
    expect(s1.run_id).toBe("r1");
    expect(s1.accounts).toEqual({});
  });

  test("account_started transitions to active", () => {
    const s = reducer(initialState, {
      type: "event",
      event: evt({ type: "account_started", account_id: "ACT-1", source: "simplefin" } as any),
    });
    expect(s.accounts["ACT-1"].state).toBe("active");
    expect(s.accounts["ACT-1"].source).toBe("simplefin");
  });

  test("account_log appends to log, capped at MAX_LOG_LINES", () => {
    let s = reducer(initialState, {
      type: "event",
      event: evt({ type: "account_started", account_id: "ACT-1", source: "simplefin" } as any),
    });
    const burst = MAX_LOG_LINES + 10;
    for (let i = 0; i < burst; i++) {
      s = reducer(s, {
        type: "event",
        event: evt({ type: "account_log", account_id: "ACT-1", message: `m${i}`, level: "info" } as any),
      });
    }
    expect(s.accounts["ACT-1"].log.length).toBe(MAX_LOG_LINES);
    expect(s.accounts["ACT-1"].log[0].message).toBe(`m${burst - MAX_LOG_LINES}`);
    expect(s.accounts["ACT-1"].log[MAX_LOG_LINES - 1].message).toBe(`m${burst - 1}`);
  });

  test("account_finished transitions to ok or error", () => {
    let s = reducer(initialState, {
      type: "event",
      event: evt({ type: "account_started", account_id: "ACT-1", source: "simplefin" } as any),
    });
    s = reducer(s, {
      type: "event",
      event: evt({ type: "account_finished", account_id: "ACT-1", ok: false } as any),
    });
    expect(s.accounts["ACT-1"].state).toBe("error");
  });

  test("sync_finished clears running but leaves account states", () => {
    let s = reducer(initialState, {
      type: "event",
      event: evt({ type: "account_started", account_id: "ACT-1", source: "simplefin" } as any),
    });
    s = reducer(s, {
      type: "event",
      event: evt({ type: "account_finished", account_id: "ACT-1", ok: true } as any),
    });
    s = reducer(s, {
      type: "event",
      event: evt({ type: "sync_finished", ok: true, totals: {} } as any),
    });
    expect(s.running).toBe(false);
    expect(s.accounts["ACT-1"].state).toBe("ok");
  });

  test("events list accumulates in arrival order, bounded at MAX_EVENTS", () => {
    let s = reducer(initialState, {
      type: "event",
      event: evt({ type: "sync_started", sources: ["simplefin"] } as any),
    });
    s = reducer(s, {
      type: "event",
      event: evt({ type: "warning", account_id: null, message: "rate limited" } as any),
    });
    expect(s.events.map((e) => e.type)).toEqual(["sync_started", "warning"]);

    // Overflow the ring buffer.
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      s = reducer(s, {
        type: "event",
        event: evt({ type: "warning", account_id: null, message: `w${i}` } as any),
      });
    }
    expect(s.events.length).toBe(MAX_EVENTS);
    // sync_started has been evicted; oldest retained event is a warning.
    expect(s.events[0].type).toBe("warning");
  });

  test("sync_started resets the events list to a single sync_started entry", () => {
    let s = reducer(initialState, {
      type: "event",
      event: evt({ type: "sync_started", sources: ["simplefin"] } as any),
    });
    s = reducer(s, {
      type: "event",
      event: evt({ type: "warning", account_id: null, message: "noise" } as any),
    });
    s = reducer(s, {
      type: "event",
      event: evt({ type: "sync_started", run_id: "r2", sources: ["simplefin"] } as any),
    });
    expect(s.events.length).toBe(1);
    expect(s.events[0].type).toBe("sync_started");
    expect(s.run_id).toBe("r2");
  });
});
