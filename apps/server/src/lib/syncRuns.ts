// dashboard/api/src/lib/syncRuns.ts
/**
 * In-memory coordinator for sync runs.
 *
 * Owns: the singleton current run (or null), an event ring buffer per
 * run, a bounded history of completed runs, and the set of SSE
 * subscribers. Subprocess lifecycle is wired via startRun, which spawns
 * the TS CLI subprocess, pumps fd 3, and finalizes on exit.
 * Test-only seams (`_startRunForTest`, `_inject`, `_finalizeForTest`,
 * `_setSpawnForTest`) remain for unit testing the state machine.
 */
import { resolve } from "node:path";
import type {
  SyncEvent,
  SyncRunSummary,
  SyncRunSnapshot,
} from "../../../../packages/shared/types";
import { runPostSyncHooks } from "./postSyncHooks";

export type TriggerKind =
  | "simplefin"
  | "defillama"
  | "zerion"
  | "alchemy"
  | "geckoterminal"
  | "coinbase";

type SpawnedProc = {
  extraFds: Array<{ readable: ReadableStream<Uint8Array> }>;
  exited: Promise<number>;
};

type SpawnFn = (argv: string[]) => SpawnedProc;

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DEFAULT_CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const DEFAULT_FINANCE_CONFIG = resolve(REPO_ROOT, "finance.config.ts");

type Subscriber = (e: SyncEvent) => void;

const DEFAULT_MAX_EVENTS_PER_RUN = 5000;
const HISTORY_LIMIT = 5;

export interface SyncRunCoordinatorOpts {
  maxEventsPerRun?: number;
  cliEntry?: string;
  configPath?: string;
  postSyncHooks?: boolean;
}

export class SyncRunCoordinator {
  private current: (SyncRunSummary & { trigger: TriggerKind; seq: number; spawned: boolean }) | null = null;
  private history: SyncRunSummary[] = [];
  private subscribers = new Set<Subscriber>();
  private readonly maxEventsPerRun: number;
  private readonly cliEntry: string;
  private readonly configPath: string;
  private lastFinished = new Map<TriggerKind, { at: number; ok: boolean }>();
  private readonly hooksEnabled: boolean;

  constructor(opts: SyncRunCoordinatorOpts = {}) {
    this.maxEventsPerRun = opts.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;
    this.cliEntry = opts.cliEntry ?? DEFAULT_CLI_ENTRY;
    this.configPath = opts.configPath ?? DEFAULT_FINANCE_CONFIG;
    this.hooksEnabled = opts.postSyncHooks ?? true;
  }

  private realSpawn: SpawnFn = (argv: string[]): SpawnedProc => {
    // stdout/stderr are inherited so child prints don't fill the OS pipe
    // buffer (~64KB) and deadlock against an unread parent. Live progress
    // flows through fd 3 — Bun exposes it as a numeric fd at proc.stdio[3]
    // when stdio[3] is "pipe"; wrap with Bun.file(fd).stream() to read it.
    const proc = Bun.spawn({
      cmd: argv,
      stdio: ["ignore", "inherit", "inherit", "pipe"],
      cwd: REPO_ROOT,
      // Bun.spawn without env: does NOT forward process.env mutations made
      // after process startup (verified: child sees undefined for dynamic vars).
      // Pass process.env explicitly so callers can inject FINANCE_DB etc.
      env: process.env,
    });
    const fd3 = (proc as any).stdio[3] as number;
    return {
      extraFds: [{ readable: Bun.file(fd3).stream() }],
      exited: proc.exited,
    };
  };

  snapshot(): SyncRunSnapshot {
    return {
      current: this.current
        ? {
            run_id: this.current.run_id,
            started_at: this.current.started_at,
            finished_at: this.current.finished_at,
            ok: this.current.ok,
            events: [...this.current.events],
          }
        : null,
      history: this.history.map((h) => ({ ...h, events: [...h.events] })),
    };
  }

  subscribe(send: Subscriber): () => void {
    if (this.current) for (const e of this.current.events) send(e);
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  /** Returns existing run_id on same-trigger coalesce, null on cross-trigger collision. */
  _startRunForTest(sources: string[], trigger: TriggerKind = "simplefin"): { run_id: string } | null {
    if (this.current) {
      if (this.current.trigger === trigger) return { run_id: this.current.run_id };
      return null;
    }
    const run_id = crypto.randomUUID();
    const started_at = new Date().toISOString();
    this.current = {
      run_id,
      started_at,
      finished_at: null,
      ok: null,
      events: [],
      trigger,
      seq: 0,
      spawned: false,
    };
    this._inject({
      type: "sync_started",
      run_id,
      sources,
      ts: started_at,
      seq: 0,
    } as SyncEvent);
    return { run_id };
  }

  _inject(e: SyncEvent): void {
    if (!this.current) return;
    const stamped: SyncEvent = {
      ...e,
      run_id: this.current.run_id,
      ts: e.ts ?? new Date().toISOString(),
      seq: this.current.seq++,
    };
    this.current.events.push(stamped);
    if (this.current.events.length > this.maxEventsPerRun) {
      this.current.events.shift();
    }
    for (const s of this.subscribers) s(stamped);
  }

  startRun(
    trigger: TriggerKind,
    syncArgs: string[],
    opts: { spawn?: SpawnFn } = {},
  ): { run_id: string } | null {
    const started = this._startRunForTest([trigger], trigger);
    if (started === null) return null;
    if (this.current?.spawned) {
      // Coalesced — already running, don't spawn a second subprocess.
      return started;
    }
    const spawn = opts.spawn ?? this.realSpawn;
    let proc: SpawnedProc;
    try {
      proc = spawn([
        "bun", this.cliEntry,
        "sync", trigger,
        "--config", this.configPath,
        "--events-fd", "3",
        ...syncArgs,
      ]);
    } catch (err) {
      console.error("[syncRuns] spawn failed:", err);
      this._finalizeForTest({ exitCode: -1 });
      return null;
    }
    this.current!.spawned = true;
    const pump = this.pumpFd(proc.extraFds[0].readable);
    proc.exited.then(async (code) => {
      await pump;
      this._finalizeForTest({ exitCode: code });
    });
    return started;
  }

  private async pumpFd(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (typeof obj.type !== "string") continue;
            // sync_started is owned by the TS coordinator (emitted by
            // _startRunForTest with the canonical run_id); drop the
            // CLI-emitted one so subscribers see exactly one.
            if (obj.type === "sync_started") continue;
            this._inject(obj as SyncEvent);
          } catch {
            console.warn("[syncRuns] malformed event line:", line);
          }
        }
      }
    } catch (err) {
      console.error("[syncRuns] pumpFd stream error:", err);
    }
  }

  _setSpawnForTest(fn: SpawnFn): void {
    this.realSpawn = fn;
  }

  _finalizeForTest(opts: { exitCode: number }): void {
    if (!this.current) return;
    const ok = opts.exitCode === 0;
    // Synthesize account_finished for any account that started but never finished.
    const startedIds = new Set<string>();
    const finishedIds = new Set<string>();
    for (const e of this.current.events) {
      if (e.type === "account_started") startedIds.add(e.account_id);
      if (e.type === "account_finished") finishedIds.add(e.account_id);
    }
    for (const id of startedIds) {
      if (!finishedIds.has(id)) {
        this._inject({
          type: "account_finished",
          run_id: this.current.run_id,
          account_id: id,
          ok: false,
          ts: new Date().toISOString(),
          seq: 0,
        } as SyncEvent);
      }
    }
    // Synthesize sync_finished if the pipeline didn't emit one.
    const last = this.current.events[this.current.events.length - 1];
    if (!last || last.type !== "sync_finished") {
      this._inject({
        type: "sync_finished",
        run_id: this.current.run_id,
        ok,
        totals: {},
        ts: new Date().toISOString(),
        seq: 0,
      } as SyncEvent);
    }
    this.current.finished_at = new Date().toISOString();
    this.current.ok = ok;
    this.lastFinished.set(this.current.trigger, { at: Date.now(), ok });
    const trigger = this.current.trigger;
    const wasSpawned = this.current.spawned;
    const { trigger: _t, seq: _s, spawned: _sp, ...summary } = this.current;
    this.history.unshift(summary);
    if (this.history.length > HISTORY_LIMIT) this.history.pop();
    this.current = null;

    if (ok && wasSpawned && this.hooksEnabled) {
      runPostSyncHooks(trigger).catch((err) =>
        console.error("[syncRuns] post-sync hooks failed:", err),
      );
    }
  }

  cooldownRemaining(trigger: TriggerKind, minIntervalMs: number): number {
    const last = this.lastFinished.get(trigger);
    if (!last || !last.ok) return 0;
    const elapsed = Date.now() - last.at;
    return Math.max(0, minIntervalMs - elapsed);
  }
}

export const syncRuns = new SyncRunCoordinator();
