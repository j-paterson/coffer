import { Hono } from "hono";
import { syncRuns as defaultSyncRuns, type SyncRunCoordinator } from "../lib/syncRuns";
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

  route.post("/simplefin", async (c) => {
    const force = c.req.query("force") === "1";
    if (!force) {
      const remaining = coord.cooldownRemaining("simplefin", SIMPLEFIN_COOLDOWN_MS);
      if (remaining > 0) {
        const retryAfterSec = Math.ceil(remaining / 1000);
        return c.json(
          { error: "SimpleFIN cooldown active", retry_after_seconds: retryAfterSec },
          429,
        );
      }
    }
    const days = Number(c.req.query("days") ?? 365);
    const args = ["--days", String(days)];
    const result = coord.startRun("simplefin", args);
    if (result === null) return c.json({ error: "different sync already in progress" }, 409);
    return c.json(result);
  });

  route.post("/zerion", async (c) => {
    const result = coord.startRun("zerion", []);
    if (result === null) return c.json({ error: "different sync already in progress" }, 409);
    return c.json(result);
  });

  route.post("/defillama", async (c) => {
    const result = coord.startRun("defillama", []);
    if (result === null) return c.json({ error: "different sync already in progress" }, 409);
    return c.json(result);
  });

  route.post("/alchemy", async (c) => {
    const result = coord.startRun("alchemy", []);
    if (result === null) return c.json({ error: "different sync already in progress" }, 409);
    return c.json(result);
  });

  route.post("/geckoterminal", async (c) => {
    const result = coord.startRun("geckoterminal", []);
    if (result === null) return c.json({ error: "different sync already in progress" }, 409);
    return c.json(result);
  });

  route.post("/coinbase", async (c) => {
    const result = coord.startRun("coinbase", []);
    if (result === null) return c.json({ error: "different sync already in progress" }, 409);
    return c.json(result);
  });

  return route;
}

export default createSyncRoute();
