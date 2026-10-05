/**
 * Server-side "sync all": runs every parser in order and records what
 * happened to each one. It lives on the server so it keeps going (and its
 * outcome stays visible) when the browser tab reloads or closes — the
 * dashboard only polls GET /api/sync/all.
 */
import type { SyncAllState, SyncAllStep, SyncRunSummary } from "../../../../packages/shared/types";
import type { SyncRunCoordinator, TriggerKind } from "./syncRuns";

// Order matters: SimpleFIN runs first so downstream parsers can reference
// the bank/card accounts it discovers. Price providers (defillama,
// geckoterminal) run after balance providers (zerion, alchemy, coinbase)
// so positions exist before prices are written. Do not reorder without
// understanding these dependencies.
export const SYNC_ALL_ORDER: TriggerKind[] = ["simplefin", "defillama", "zerion", "alchemy", "geckoterminal", "coinbase"];

export type StartResult =
  | { ok: true; run_id: string }
  | { ok: false; status: 429; retry_after_seconds: number }
  | { ok: false; status: 409 };

/** Last error-ish line a run emitted, for the "failed: …" notice. */
function failureMessage(run: SyncRunSummary): string {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i]!;
    if (e.type === "warning" || (e.type === "account_log" && e.level === "error")) return e.message;
  }
  return "sync exited with an error";
}

export class SyncAllRunner {
  private state: SyncAllState | null = null;

  constructor(
    private readonly coord: SyncRunCoordinator,
    private readonly start: (id: TriggerKind) => StartResult,
  ) {}

  snapshot(): SyncAllState | null {
    return this.state && { ...this.state, steps: this.state.steps.map((s) => ({ ...s })) };
  }

  /** Starts a chain, or returns the one already running. */
  run(): { state: SyncAllState; done: Promise<void> } {
    if (this.state && !this.state.finished_at) return { state: this.snapshot()!, done: Promise.resolve() };
    this.state = {
      id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      finished_at: null,
      steps: SYNC_ALL_ORDER.map((id) => ({ id, status: "pending" })),
    };
    const done = this.chain(this.state).catch((err) => {
      console.error("[syncAll] chain crashed:", err);
    });
    return { state: this.snapshot()!, done };
  }

  private async chain(state: SyncAllState): Promise<void> {
    for (const step of state.steps) {
      step.status = "running";
      try {
        await this.runStep(step);
      } catch (err) {
        Object.assign(step, { status: "failed", message: err instanceof Error ? err.message : String(err) });
      }
    }
    state.finished_at = new Date().toISOString();
  }

  private async runStep(step: SyncAllStep): Promise<void> {
    let started = this.start(step.id);
    // Another sync (e.g. a single-parser click) holds the coordinator: wait
    // for it, then try once more.
    for (let i = 0; i < 3 && !started.ok && started.status === 409; i++) {
      const busy = this.coord.currentRunId();
      if (busy) await this.coord.waitForRun(busy);
      started = this.start(step.id);
    }
    if (!started.ok) {
      if (started.status === 429) {
        Object.assign(step, {
          status: "skipped",
          retry_at: new Date(Date.now() + started.retry_after_seconds * 1000).toISOString(),
        });
      } else {
        Object.assign(step, { status: "failed", message: "another sync kept running" });
      }
      return;
    }
    step.run_id = started.run_id;
    const run = await this.coord.waitForRun(started.run_id);
    if (run.ok) step.status = "completed";
    else Object.assign(step, { status: "failed", message: failureMessage(run) });
  }
}
