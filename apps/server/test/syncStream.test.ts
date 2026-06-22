import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import syncRoute from "../src/routes/sync";
import { syncRuns } from "../src/lib/syncRuns";
import { createTestCtx } from "./setup";

describe("sync streaming", () => {
  test("POST /api/sync/zerion returns 409 when a different trigger is in flight", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("ctx", createTestCtx());
      await next();
    });
    app.route("/api/sync", syncRoute);
    // Seed a run with trigger="simplefin" — zerion is a different trigger.
    syncRuns._startRunForTest(["simplefin"], "simplefin");
    const res = await app.request("/api/sync/zerion", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("different sync");
    syncRuns._finalizeForTest({ exitCode: 0 });
  });

  test("GET /runs returns snapshot from coordinator", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("ctx", createTestCtx());
      await next();
    });
    app.route("/api/sync", syncRoute);
    const res = await app.request("/api/sync/runs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
  });

  test("GET /stream sets SSE headers and streams events", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("ctx", createTestCtx());
      await next();
    });
    app.route("/api/sync", syncRoute);
    syncRuns._startRunForTest(["simplefin"], "simplefin");
    const res = await app.request("/api/sync/stream");
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value!);
    expect(chunk).toContain("sync_started");
    expect(chunk.startsWith("data: ")).toBe(true);
    reader.cancel();
    syncRuns._finalizeForTest({ exitCode: 0 });
  });

  test("GET /stream sets X-Accel-Buffering: no for proxy compatibility", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("ctx", createTestCtx());
      await next();
    });
    app.route("/api/sync", syncRoute);
    syncRuns._startRunForTest(["simplefin"], "simplefin");
    const res = await app.request("/api/sync/stream");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    res.body!.cancel();
    syncRuns._finalizeForTest({ exitCode: 0 });
  });

  test("POST /api/sync/all is 404 (route removed)", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("ctx", createTestCtx());
      await next();
    });
    app.route("/api/sync", syncRoute);
    const res = await app.request("/api/sync/all", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test.each([
    ["defillama"],
    ["alchemy"],
    ["geckoterminal"],
    ["coinbase"],
  ])("POST /api/sync/%s returns 409 when a different trigger is in flight", async (id) => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("ctx", createTestCtx());
      await next();
    });
    app.route("/api/sync", syncRoute);
    // Seed a run with a different parser id.
    syncRuns._startRunForTest(["simplefin"], "simplefin");
    const res = await app.request(`/api/sync/${id}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("different sync");
    syncRuns._finalizeForTest({ exitCode: 0 });
  });
});
