// apps/server/src/routes/__tests__/connections.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import connectionsRoute from "../connections";
import type { Ctx } from "../../ctx";
import { applyMigrations } from "../../db";

let db: Database;
beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
afterEach(() => db.close());

function makeApp(d: Database) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const ctx: Ctx = { db: d, today: "2026-06-16" };
  app.use("*", async (c, next) => { c.set("ctx", ctx); await next(); });
  app.route("/api/connections", connectionsRoute);
  return app;
}
const post = (app: ReturnType<typeof makeApp>, p: string, body: unknown) =>
  app.request(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("connect zerion stores secret + wallets config; GET never returns the secret", async () => {
  const app = makeApp(db);
  const addr = "0x" + "b".repeat(40);
  const res = await post(app, "/api/connections/zerion", { api_key: "zk_secret", wallets: `${addr}\n` });
  expect(res.status).toBe(200);

  expect((db.prepare("SELECT value FROM provider_secrets WHERE name='ZERION_API_KEY'").get() as { value: string }).value).toBe("zk_secret");
  const conn = db.prepare("SELECT config_json, status FROM provider_connections WHERE parser_id='zerion'").get() as { config_json: string; status: string };
  expect(JSON.parse(conn.config_json).wallets).toEqual([addr]);
  expect(conn.status).toBe("connected");

  const list = (await (await app.request("/api/connections")).json()) as Array<Record<string, unknown>>;
  const zerion = list.find((p) => p.id === "zerion")!;
  expect(zerion.connected).toBe(true);
  expect(JSON.stringify(list)).not.toContain("zk_secret"); // secret never serialized
});

test("connect simplefin with an access URL stores it directly (no network)", async () => {
  const app = makeApp(db);
  const url = "https://u:p@bridge.simplefin.org/access";
  const res = await post(app, "/api/connections/simplefin", { token: url });
  expect(res.status).toBe(200);
  expect((db.prepare("SELECT value FROM provider_secrets WHERE name='SIMPLEFIN_ACCESS_URL'").get() as { value: string }).value).toBe(url);
});

test("disconnect deletes the provider's secrets", async () => {
  const app = makeApp(db);
  await post(app, "/api/connections/zerion", { api_key: "zk_x", wallets: "" });
  const res = await post(app, "/api/connections/zerion/disconnect", {});
  expect(res.status).toBe(200);
  expect(db.prepare("SELECT COUNT(*) n FROM provider_secrets WHERE name='ZERION_API_KEY'").get()).toEqual({ n: 0 });
  expect((db.prepare("SELECT status FROM provider_connections WHERE parser_id='zerion'").get() as { status: string }).status).toBe("disconnected");
});

test("missing required field → 400; unknown provider → 404", async () => {
  const app = makeApp(db);
  expect((await post(app, "/api/connections/zerion", { wallets: "" })).status).toBe(400); // no api_key
  expect((await post(app, "/api/connections/nope", { x: 1 })).status).toBe(404);
});

test("simplefin with malformed setup token (decodes to non-URL) → 400", async () => {
  const app = makeApp(db);
  const token = Buffer.from("not-a-url", "utf8").toString("base64");
  const res = await post(app, "/api/connections/simplefin", { token });
  expect(res.status).toBe(400);
});

test("enable toggle updates the row", async () => {
  const app = makeApp(db);
  await post(app, "/api/connections/defillama", {});
  const res = await post(app, "/api/connections/defillama/enable", { enabled: 0 });
  expect(res.status).toBe(200);
  expect((db.prepare("SELECT enabled FROM provider_connections WHERE parser_id='defillama'").get() as { enabled: number }).enabled).toBe(0);
});

test("GET returns non-secret config + configured secret names, never the value", async () => {
  const app = makeApp(db);
  const addr = "0x" + "c".repeat(40);
  await post(app, "/api/connections/zerion", { api_key: "zk_topsecret", wallets: addr });
  const list = (await (await app.request("/api/connections")).json()) as Array<{
    id: string; config: Record<string, unknown>; configuredSecrets: string[];
  }>;
  const zerion = list.find((p) => p.id === "zerion")!;
  expect(zerion.config.wallets).toEqual([addr]);
  expect(zerion.configuredSecrets).toContain("ZERION_API_KEY");
  expect(JSON.stringify(list)).not.toContain("zk_topsecret");
});

test("editing with a new secret value overwrites the existing one", async () => {
  const app = makeApp(db);
  await post(app, "/api/connections/zerion", { api_key: "zk_old", wallets: "" });
  const res = await post(app, "/api/connections/zerion", { api_key: "zk_new", wallets: "" });
  expect(res.status).toBe(200);
  const row = db.prepare("SELECT value FROM provider_secrets WHERE name='ZERION_API_KEY'").get() as { value: string };
  expect(row.value).toBe("zk_new");
});

test("editing keeps a blank secret and updates config; blank secret on fresh connect still 400s", async () => {
  const app = makeApp(db);
  const addr1 = "0x" + "d".repeat(40);
  const addr2 = "0x" + "e".repeat(40);
  // initial connect
  await post(app, "/api/connections/zerion", { api_key: "zk_keep", wallets: addr1 });
  // edit: blank api_key (keep), new wallets
  const res = await post(app, "/api/connections/zerion", { api_key: "", wallets: addr2 });
  expect(res.status).toBe(200);
  expect((db.prepare("SELECT value FROM provider_secrets WHERE name='ZERION_API_KEY'").get() as { value: string }).value).toBe("zk_keep");
  const conn = db.prepare("SELECT config_json FROM provider_connections WHERE parser_id='zerion'").get() as { config_json: string };
  expect(JSON.parse(conn.config_json).wallets).toEqual([addr2]);

  // fresh connect with a blank required secret still fails
  const res2 = await post(app, "/api/connections/alchemy", { api_key: "", wallets: "" });
  expect(res2.status).toBe(400);
});
