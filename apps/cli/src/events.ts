import { writeSync } from "node:fs";
import type {
  SyncEvent,
  SyncStartedEvent,
  SyncFinishedEvent,
  SyncWarningEvent,
} from "../../../packages/shared/types";

export interface EventsEmitter {
  syncStarted(payload: Omit<SyncStartedEvent, "ts" | "seq" | "type">): void;
  syncFinished(payload: Omit<SyncFinishedEvent, "ts" | "seq" | "type">): void;
  warning(payload: Omit<SyncWarningEvent, "ts" | "seq" | "type">): void;
}

export function makeEventsEmitter(fd: number | undefined): EventsEmitter {
  if (fd == null) {
    return { syncStarted() {}, syncFinished() {}, warning() {} };
  }
  let seq = 0;
  const emit = (event: SyncEvent): void => {
    writeSync(fd, JSON.stringify(event) + "\n");
  };
  return {
    syncStarted: (p) => emit({ type: "sync_started", ts: new Date().toISOString(), seq: seq++, ...p }),
    syncFinished: (p) => emit({ type: "sync_finished", ts: new Date().toISOString(), seq: seq++, ...p }),
    warning: (p) => emit({ type: "warning", ts: new Date().toISOString(), seq: seq++, ...p }),
  };
}
