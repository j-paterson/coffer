import { useState } from "react";
import { useSyncEvents, useSyncRunning } from "../../lib/syncStream";
import type { SyncEvent } from "../../../../../packages/shared/types";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
  return d.toTimeString().slice(0, 8);
}

function formatEvent(e: SyncEvent): string {
  switch (e.type) {
    case "sync_started":
      return `sync started — sources: ${e.sources.join(", ") || "(none)"}`;
    case "sync_finished":
      return `sync finished — ok=${e.ok}`;
    case "account_started":
      return `[${e.source}] ${e.account_id} — started`;
    case "account_finished":
      return `${e.account_id} — finished (ok=${e.ok})`;
    case "account_log":
      return `[${e.level}] ${e.account_id}: ${e.message}`;
    case "warning":
      return e.account_id
        ? `WARNING ${e.account_id}: ${e.message}`
        : `WARNING: ${e.message}`;
  }
}

function eventToneClass(e: SyncEvent): string {
  switch (e.type) {
    case "sync_started":
      return "text-stone-700";
    case "sync_finished":
      return e.ok ? "text-emerald-700" : "text-rose-700";
    case "account_started":
      return "text-stone-500";
    case "account_finished":
      return e.ok ? "text-emerald-700" : "text-rose-700";
    case "account_log":
      if (e.level === "error") return "text-rose-700";
      if (e.level === "warn") return "text-amber-700";
      return "text-stone-500";
    case "warning":
      return "text-amber-700";
  }
}

export function SyncDebugLog() {
  const events = useSyncEvents();
  const running = useSyncRunning();
  const [open, setOpen] = useState(false);

  if (events.length === 0) return null;

  const finished = events.find((e) => e.type === "sync_finished") as
    | { ok: boolean }
    | undefined;
  const status = running
    ? "running"
    : finished
      ? finished.ok
        ? "ok"
        : "failed"
      : "active";
  const statusClass =
    status === "running"
      ? "bg-blue-100 text-blue-800"
      : status === "ok"
        ? "bg-emerald-100 text-emerald-800"
        : status === "failed"
          ? "bg-rose-100 text-rose-800"
          : "bg-stone-100 text-stone-700";

  return (
    <div data-testid="sync-debug-log" className="mb-4 rounded-md border border-stone-200 bg-stone-50 px-4 py-2 text-sm">
      <button
        type="button"
        data-testid="sync-debug-log-toggle"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <span className="flex items-center gap-3">
          <span
            data-testid="sync-debug-log-status"
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusClass}`}
          >
            {status}
          </span>
          <span className="text-stone-700">
            Sync log · {events.length} event{events.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="text-xs text-stone-500">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ol className="mt-2 max-h-96 overflow-auto space-y-0.5 font-mono text-xs">
          {events.map((e) => (
            <li key={`${e.run_id}-${e.seq}`} className={eventToneClass(e)}>
              <span className="text-stone-400">{formatTime(e.ts)}</span>{" "}
              {formatEvent(e)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
