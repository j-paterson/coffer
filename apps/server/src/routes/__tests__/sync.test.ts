import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSyncRoute } from "../sync";
import { SyncRunCoordinator } from "../../lib/syncRuns";

function makeApp(coord: SyncRunCoordinator) {
  const app = new Hono();
  app.route("/api/sync", createSyncRoute(coord));
  return app;
}

function stubSpawn(captured: { argv: string[] | null }) {
  return (argv: string[]) => {
    captured.argv = argv;
    return {
      extraFds: [{
        readable: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
      }],
      exited: Promise.resolve(0),
    };
  };
}

describe("sync routes — argv assertions", () => {
  test.each([
    ["simplefin"],
    ["defillama"],
    ["zerion"],
    ["alchemy"],
    ["geckoterminal"],
    ["coinbase"],
  ])("POST /api/sync/%s spawns the TS CLI with the expected argv", async (id) => {
    const coord = new SyncRunCoordinator({
      cliEntry: "/abs/cli.ts",
      configPath: "/abs/finance.config.ts",
    });
    const captured: { argv: string[] | null } = { argv: null };
    coord._setSpawnForTest(stubSpawn(captured));

    const app = makeApp(coord);
    const res = await app.request(`/api/sync/${id}`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { run_id: string };
    expect(typeof body.run_id).toBe("string");

    const expected = id === "simplefin"
      ? [
          "bun", "/abs/cli.ts",
          "sync", "simplefin",
          "--config", "/abs/finance.config.ts",
          "--events-fd", "3",
          "--days", "365",
        ]
      : [
          "bun", "/abs/cli.ts",
          "sync", id,
          "--config", "/abs/finance.config.ts",
          "--events-fd", "3",
        ];
    expect(captured.argv).toEqual(expected);

    await new Promise((r) => setTimeout(r, 5));
  });

  test("POST /api/sync/simplefin?days=30 produces argv ending in --days 30", async () => {
    const coord = new SyncRunCoordinator({
      cliEntry: "/abs/cli.ts",
      configPath: "/abs/finance.config.ts",
    });
    const captured: { argv: string[] | null } = { argv: null };
    coord._setSpawnForTest(stubSpawn(captured));
    const app = makeApp(coord);
    const res = await app.request("/api/sync/simplefin?days=30", { method: "POST" });
    expect(res.status).toBe(200);
    expect(captured.argv![captured.argv!.length - 2]).toBe("--days");
    expect(captured.argv![captured.argv!.length - 1]).toBe("30");
    await new Promise((r) => setTimeout(r, 5));
  });

  test("POST /api/sync/all returns 404", async () => {
    const coord = new SyncRunCoordinator();
    const app = makeApp(coord);
    const res = await app.request("/api/sync/all", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("cross-trigger collision returns 409", async () => {
    const coord = new SyncRunCoordinator();
    // Use a never-resolving exited so the run stays active for the second request.
    coord._setSpawnForTest((_argv: string[]) => ({
      extraFds: [{
        readable: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
      }],
      exited: new Promise<number>(() => {}),
    }));
    const app = makeApp(coord);
    await app.request("/api/sync/simplefin", { method: "POST" });
    const res = await app.request("/api/sync/defillama", { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("same-trigger coalesces — same run_id, spawn called once", async () => {
    const coord = new SyncRunCoordinator();
    let spawnCount = 0;
    coord._setSpawnForTest((argv: string[]) => {
      spawnCount++;
      return {
        extraFds: [{
          readable: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        }],
        exited: new Promise<number>(() => {}),
      };
    });
    const app = makeApp(coord);
    const a = await (await app.request("/api/sync/simplefin", { method: "POST" })).json() as { run_id: string };
    const b = await (await app.request("/api/sync/simplefin", { method: "POST" })).json() as { run_id: string };
    expect(a.run_id).toBe(b.run_id);
    expect(spawnCount).toBe(1);
  });
});
