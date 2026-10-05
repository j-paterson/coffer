import { SyncTriggerError } from "./api";

// Order matters: SimpleFIN runs first so downstream parsers can reference
// the bank/card accounts it discovers. Price providers (defillama,
// geckoterminal) run after balance providers (zerion, alchemy, coinbase)
// so positions exist before prices are written. Do not reorder without
// understanding these dependencies.
export const SYNC_ALL_ORDER = ["simplefin", "defillama", "zerion", "alchemy", "geckoterminal", "coinbase"] as const;
export type ParserId = (typeof SYNC_ALL_ORDER)[number];

export type SyncAllOutcome = {
  completed: ParserId[];
  /** Refused by a cooldown (HTTP 429). Expected, not an error. */
  skipped: { id: ParserId; retryAfterSeconds: number | null }[];
  failed: { id: ParserId; message: string }[];
};

/** Trigger each parser in order, waiting for each run to finish. A refusal
 *  no longer aborts the chain: a cooldown is recorded as skipped and any
 *  other error as failed, and the remaining parsers still run (each one only
 *  needs accounts already in the ledger, not a fresh sync of the previous). */
export async function runSyncAll(
  trigger: Record<ParserId, () => Promise<{ run_id: string }>>,
  waitForFinish: (runId: string) => Promise<void>,
): Promise<SyncAllOutcome> {
  const out: SyncAllOutcome = { completed: [], skipped: [], failed: [] };
  for (const id of SYNC_ALL_ORDER) {
    try {
      const { run_id } = await trigger[id]();
      await waitForFinish(run_id);
      out.completed.push(id);
    } catch (e) {
      if (e instanceof SyncTriggerError && e.status === 429) {
        out.skipped.push({ id, retryAfterSeconds: e.retryAfterSeconds });
      } else {
        out.failed.push({ id, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return out;
}

const PARSER_LABEL: Record<ParserId, string> = {
  simplefin: "SimpleFIN",
  defillama: "DefiLlama",
  zerion: "Zerion",
  alchemy: "Alchemy",
  geckoterminal: "GeckoTerminal",
  coinbase: "Coinbase",
};

/** "3:04 AM" for a retry-after in seconds, or null when unknown. */
export function retryClock(retryAfterSeconds: number | null, now = Date.now()): string | null {
  if (retryAfterSeconds == null) return null;
  return new Date(now + retryAfterSeconds * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One line for the toolbar, or null when everything ran. */
export function describeSyncAll(o: SyncAllOutcome, now = Date.now()): string | null {
  const parts: string[] = [];
  for (const s of o.skipped) {
    const at = retryClock(s.retryAfterSeconds, now);
    parts.push(`${PARSER_LABEL[s.id]} skipped (cooldown${at ? ` until ${at}` : ""})`);
  }
  for (const f of o.failed) parts.push(`${PARSER_LABEL[f.id]} failed: ${f.message}`);
  return parts.length ? parts.join(" · ") : null;
}
