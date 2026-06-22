// apps/server/src/routes/connections.ts
import { Hono } from "hono";
import type { Ctx } from "../ctx";
import { PROVIDERS, getProvider } from "../../../../packages/shared/providers";
import { resolveSimplefinAccessUrl } from "../lib/simplefinClaim";

const route = new Hono();

/** Split a textarea/multi value into a trimmed, non-empty string list. */
function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

route.get("/", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const rows = ctx.db
    .prepare("SELECT parser_id, enabled, status, last_connected_at, config_json FROM provider_connections")
    .all() as Array<{
      parser_id: string; enabled: number; status: string;
      last_connected_at: string | null; config_json: string;
    }>;
  const byId = new Map(rows.map((r) => [r.parser_id, r]));
  // Names only — the `value` column is never read, so secrets cannot leak.
  const secretNames = new Set(
    (ctx.db.prepare("SELECT name FROM provider_secrets").all() as Array<{ name: string }>).map((r) => r.name),
  );
  return c.json(
    PROVIDERS.map((p) => {
      const row = byId.get(p.id);
      let config: Record<string, unknown> = {};
      if (row?.config_json) {
        try { config = JSON.parse(row.config_json) as Record<string, unknown>; } catch { config = {}; }
      }
      const configuredSecrets = p.fields
        .filter((f) => f.secretName && secretNames.has(f.secretName))
        .map((f) => f.secretName as string);
      return {
        id: p.id,
        label: p.label,
        needsAuth: p.needsAuth,
        enabled: row ? row.enabled === 1 : true,
        status: row?.status ?? "disconnected",
        connected: row?.status === "connected",
        last_connected_at: row?.last_connected_at ?? null,
        config,
        configuredSecrets,
      };
    }),
  );
});

route.post("/:id", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = c.req.param("id");
  const provider = getProvider(id);
  if (!provider) return c.json({ error: "unknown provider" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // Secrets already stored — a blank secret field keeps these; a blank field
  // with no existing secret is a required-field error (fresh connect).
  const existing = new Set(
    (ctx.db.prepare("SELECT name FROM provider_secrets").all() as Array<{ name: string }>).map((r) => r.name),
  );

  const secrets: Array<[string, string]> = [];
  const config: Record<string, unknown> = {};
  for (const f of provider.fields) {
    const raw = body[f.key];
    if (f.secretName) {
      const value = String(raw ?? "").trim();
      if (value === "") {
        if (!existing.has(f.secretName)) return c.json({ error: `missing field: ${f.key}` }, 400);
        continue; // keep existing secret
      }
      let v = value;
      if (provider.special === "simplefin") {
        try {
          v = await resolveSimplefinAccessUrl(value);
        } catch (e) {
          const msg = (e as Error).message;
          return c.json({ error: msg }, msg.startsWith("invalid SimpleFIN") ? 400 : 502);
        }
      }
      secrets.push([f.secretName, v]);
    } else if (f.configKey) {
      config[f.configKey] = f.multi ? toList(raw) : String(raw ?? "").trim();
    }
  }

  const tx = ctx.db.transaction(() => {
    for (const [name, value] of secrets) {
      ctx.db
        .prepare(
          `INSERT INTO provider_secrets (name, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(name, value);
    }
    ctx.db
      .prepare(
        `INSERT INTO provider_connections (parser_id, enabled, config_json, status, last_connected_at)
         VALUES (?, 1, ?, 'connected', datetime('now'))
         ON CONFLICT(parser_id) DO UPDATE SET
           enabled = 1, config_json = excluded.config_json,
           status = 'connected', last_connected_at = excluded.last_connected_at`,
      )
      .run(id, JSON.stringify(config));
  });
  tx();

  return c.json({ id, status: "connected", connected: true });
});

route.post("/:id/disconnect", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = c.req.param("id");
  const provider = getProvider(id);
  if (!provider) return c.json({ error: "unknown provider" }, 404);
  const tx = ctx.db.transaction(() => {
    for (const f of provider.fields) {
      if (f.secretName) ctx.db.prepare("DELETE FROM provider_secrets WHERE name = ?").run(f.secretName);
    }
    ctx.db
      .prepare(
        `INSERT INTO provider_connections (parser_id, status) VALUES (?, 'disconnected')
         ON CONFLICT(parser_id) DO UPDATE SET status = 'disconnected'`,
      )
      .run(id);
  });
  tx();
  return c.json({ id, status: "disconnected", connected: false });
});

route.post("/:id/enable", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = c.req.param("id");
  if (!getProvider(id)) return c.json({ error: "unknown provider" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: number };
  if (body.enabled == null) return c.json({ error: "missing field: enabled" }, 400);
  const enabled = body.enabled ? 1 : 0;
  ctx.db
    .prepare(
      `INSERT INTO provider_connections (parser_id, enabled) VALUES (?, ?)
       ON CONFLICT(parser_id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .run(id, enabled);
  return c.json({ id, enabled });
});

export default route;
