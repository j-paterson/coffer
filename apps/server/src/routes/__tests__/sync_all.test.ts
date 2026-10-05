import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createSyncRoute } from "../sync";
import { SyncRunCoordinator } from "../../lib/syncRuns";
import type { SyncAllState } from "../../../../../packages/shared/types";

/** Spawn stub: each parser exits with the given code; a failing one first
 *  emits a warning event on fd 3 like the real CLI. */
function coordWith(exitCodes: Record<string, number> = {}, calls: string[] = []) {
  const coord = new SyncRunCoordinator({ postSyncHooks: false });
  coord._setSpawnForTest((argv) => {
    const id = argv[3]!;
    calls.push(id);
    const code = exitCodes[id] ?? 0;
    const line = code ? JSON.stringify({ type: "warning", account_id: null, message: `${id} token rejected` }) + "\n" : "";
    return {
      extraFds: [{
        readable: new ReadableStream<Uint8Array>({
          start(c) {
            if (line) c.enqueue(new TextEncoder().encode(line));
            c.close();
          },
        }),
      }],
      exited: Promise.resolve(code),
    };
  });
  const app = new Hono();
  app.route("/api/sync", createSyncRoute(coord));
  return { coord, app };
}

async function finished(app: Hono): Promise<SyncAllState> {
  for (let i = 0; i < 200; i++) {
    const s = (await (await app.request("/api/sync/all")).json()) as SyncAllState | null;
    if (s?.finished_at) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("sync all did not finish");
}

const statuses = (s: SyncAllState) => Object.fromEntries(s.steps.map((x) => [x.id, x.status]));

test("GET /api/sync/all is null before any chain has run", async () => {
  const { app } = coordWith();
  expect(await (await app.request("/api/sync/all")).json()).toBeNull();
});

test("runs every parser in order on the server", async () => {
  const calls: string[] = [];
  const { app } = coordWith({}, calls);
  const res = await app.request("/api/sync/all", { method: "POST" });
  expect(res.status).toBe(200);
  const s = await finished(app);
  expect(calls).toEqual(["simplefin", "defillama", "zerion", "alchemy", "geckoterminal", "coinbase"]);
  expect(Object.values(statuses(s)).every((x) => x === "completed")).toBe(true);
});

test("a cooldown is recorded as skipped with its retry time, and the rest still run", async () => {
  const calls: string[] = [];
  const { app } = coordWith({}, calls);
  await app.request("/api/sync/simplefin", { method: "POST" });
  await new Promise((r) => setTimeout(r, 10)); // let that run finish
  calls.length = 0;

  await app.request("/api/sync/all", { method: "POST" });
  const s = await finished(app);
  const sf = s.steps.find((x) => x.id === "simplefin")!;
  expect(sf.status).toBe("skipped");
  expect(Date.parse(sf.retry_at!) - Date.now()).toBeGreaterThan(7 * 3600_000);
  expect(calls).toEqual(["defillama", "zerion", "alchemy", "geckoterminal", "coinbase"]);
});

test("a failing parser is recorded with its message and does not stop the chain", async () => {
  const { app } = coordWith({ zerion: 1 });
  await app.request("/api/sync/all", { method: "POST" });
  const s = await finished(app);
  expect(statuses(s)).toMatchObject({ zerion: "failed", alchemy: "completed", coinbase: "completed" });
  expect(s.steps.find((x) => x.id === "zerion")!.message).toBe("zerion token rejected");
});

test("a second POST while running returns the same chain instead of starting another", async () => {
  const { app } = coordWith();
  const a = (await (await app.request("/api/sync/all", { method: "POST" })).json()) as SyncAllState;
  const b = (await (await app.request("/api/sync/all", { method: "POST" })).json()) as SyncAllState;
  expect(b.id).toBe(a.id);
  await finished(app);
});
