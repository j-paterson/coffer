import { resolve } from "node:path";
import type { TriggerKind } from "./syncRuns";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const FINANCE_CLI = resolve(REPO_ROOT, ".venv/bin/finance");

const CRYPTO_TRIGGERS = new Set<TriggerKind>(["zerion", "alchemy", "coinbase"]);

interface HookResult {
  step: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

async function runStep(step: string, args: string[]): Promise<HookResult> {
  const start = Date.now();
  try {
    const proc = Bun.spawn({
      cmd: [FINANCE_CLI, ...args],
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        step,
        ok: false,
        durationMs: Date.now() - start,
        error: stderr.slice(0, 500),
      };
    }
    return { step, ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      step,
      ok: false,
      durationMs: Date.now() - start,
      error: String(err),
    };
  }
}

export async function runPostSyncHooks(trigger: TriggerKind): Promise<HookResult[]> {
  const results: HookResult[] = [];

  results.push(await runStep("reconcile:dedup", ["reconcile", "dedup"]));
  results.push(await runStep("reconcile:transfers", ["reconcile", "transfers"]));
  results.push(await runStep("categorize", ["categorize", "--uncategorized"]));

  if (trigger === "simplefin") {
    results.push(await runStep("backfill:prices", ["backfill", "prices"]));
  }

  if (CRYPTO_TRIGGERS.has(trigger)) {
    results.push(await runStep("backfill:defillama", ["backfill", "defillama"]));
    results.push(await runStep("backfill:crypto", ["backfill", "crypto"]));
    results.push(await runStep("backfill:qty-walk", ["backfill", "qty-walk"]));
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.warn(
      `[postSyncHooks] ${failed.length}/${results.length} step(s) failed:`,
      failed.map((f) => `${f.step}: ${f.error ?? "unknown"}`).join("; "),
    );
  } else {
    const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
    console.log(
      `[postSyncHooks] ${results.length} step(s) completed in ${(totalMs / 1000).toFixed(1)}s`,
    );
  }

  return results;
}
