import type { SyncAllState, SyncAllStep } from "../../../../packages/shared/types";

// The chain itself runs on the server (POST /api/sync/all) so it survives
// reloads; this module only turns its state into toolbar text.

const PARSER_LABEL: Record<SyncAllStep["id"], string> = {
  simplefin: "SimpleFIN",
  defillama: "DefiLlama",
  zerion: "Zerion",
  alchemy: "Alchemy",
  geckoterminal: "GeckoTerminal",
  coinbase: "Coinbase",
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** "3:04 AM" for a retry-after in seconds, or null when unknown. */
export function retryClock(retryAfterSeconds: number | null, now = Date.now()): string | null {
  return retryAfterSeconds == null ? null : clock(now + retryAfterSeconds * 1000);
}

/** One line for the toolbar: progress while running, then any skips or
 *  failures. Null when the last chain ran everything. */
export function describeSyncAll(s: SyncAllState): string | null {
  const parts: string[] = [];
  const running = s.steps.findIndex((x) => x.status === "running");
  if (!s.finished_at && running >= 0) {
    parts.push(`Syncing ${PARSER_LABEL[s.steps[running]!.id]} (${running + 1}/${s.steps.length})…`);
  }
  for (const x of s.steps) {
    if (x.status === "skipped") {
      parts.push(`${PARSER_LABEL[x.id]} skipped (cooldown${x.retry_at ? ` until ${clock(Date.parse(x.retry_at))}` : ""})`);
    } else if (x.status === "failed") {
      parts.push(`${PARSER_LABEL[x.id]} failed: ${x.message ?? "unknown error"}`);
    }
  }
  if (s.finished_at && parts.length) parts.unshift(`Sync all at ${clock(Date.parse(s.started_at))}:`);
  return parts.length ? parts.join(" · ").replace(": · ", ": ") : null;
}
