import { Hono } from "hono";
import { syncRuns as defaultSyncRuns, type SyncRunCoordinator, type TriggerKind } from "../lib/syncRuns";
import { SYNC_ALL_ORDER, SyncAllRunner, type StartResult } from "../lib/syncAll";
import type { SyncEvent } from "../../../../packages/shared/types";

export function createSyncRoute(coord: SyncRunCoordinator = defaultSyncRuns): Hono {
  const route = new Hono();

  route.get("/runs", (c) => c.json(coord.snapshot()));

  route.get("/stream", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (e: SyncEvent) => {
          try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {}
        };
        let unsubscribe: (() => void) | undefined;
        const heartbeat = setInterval(() => {
          try { controller.enqueue(enc.encode(`: keepalive\n\n`)); } catch {}
        }, 30_000);
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          unsubscribe?.();
          try { controller.close(); } catch {}
        });
        unsubscribe = coord.subscribe(send);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  const SIMPLEFIN_COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours

  function startParser(id: TriggerKind, opts: { force?: boolean; days?: number } = {}): StartResult {
    if (id === "simplefin" && !opts.force) {
      const remaining = coord.cooldownRemaining("simplefin", SIMPLEFIN_COOLDOWN_MS);
      if (remaining > 0) return { ok: false, status: 429, retry_after_seconds: Math.ceil(remaining / 1000) };
    }
    const args = id === "simplefin" ? ["--days", String(opts.days ?? 365)] : [];
    const result = coord.startRun(id, args);
    return result === null ? { ok: false, status: 409 } : { ok: true, run_id: result.run_id };
  }

  const all = new SyncAllRunner(coord, (id) => startParser(id));
  route.get("/all", (c) => c.json(all.snapshot()));
  route.post("/all", (c) => c.json(all.run().state));

  for (const id of SYNC_ALL_ORDER) {
    route.post(`/${id}`, (c) => {
      const result = startParser(id, {
        force: c.req.query("force") === "1",
        days: Number(c.req.query("days") ?? 365),
      });
      if (result.ok) return c.json({ run_id: result.run_id });
      if (result.status === 429) {
        return c.json(
          { error: "SimpleFIN cooldown active", retry_after_seconds: result.retry_after_seconds },
          429,
        );
      }
      return c.json({ error: "different sync already in progress" }, 409);
    });
  }

  return route;
}

export default createSyncRoute();
