import { Hono } from "hono";
import cashflowRoute from "./routes/cashflow";
import debtRoute from "./routes/debt";
import itemsRoute from "./routes/items";
import investmentsRoute from "./routes/investments";
import networthRoute from "./routes/networth";
import accountsRoute from "./routes/accounts";
import portfolioRoute from "./routes/portfolio";
import spendingRoute from "./routes/spending";
import summaryRoute from "./routes/summary";
import syncRoute from "./routes/sync";
import transactionsRoute from "./routes/transactions";
import bundlesRoute from "./routes/bundles";
import goalsRoute from "./routes/goals";
import projectionsRoute from "./routes/projections";
import advisorRoute from "./routes/advisor";
import { openProductionDb } from "./db";
import { todayISO } from "@coffer/ledger/walker";
import type { Ctx } from "./ctx";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EmailParserSchema, type FinanceConfigInput } from "@coffer/config";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

// On startup, load finance.config.ts (if present) and write the resolved
// parsers.email config to db/.cache/email-config.json so the Python
// pipeline can pick it up without a running Zod environment.
(async () => {
  const configPath = resolve(REPO_ROOT, "finance.config.ts");
  if (!existsSync(configPath)) return;
  try {
    const mod = await import(pathToFileURL(configPath).href) as { default?: FinanceConfigInput };
    const emailInput = mod.default?.parsers?.email;
    if (!emailInput) return;
    const parsed = EmailParserSchema.safeParse(emailInput);
    if (!parsed.success) {
      console.warn("[api] parsers.email config invalid — skipping cache write:", parsed.error.message);
      return;
    }
    const cacheDir = resolve(REPO_ROOT, "db/.cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(resolve(cacheDir, "email-config.json"), JSON.stringify(parsed.data, null, 2));
    console.log("[api] wrote db/.cache/email-config.json from parsers.email config");
  } catch (e) {
    console.warn("[api] could not load finance.config.ts for email cache:", (e as Error).message);
  }
})();

declare module "hono" {
  interface ContextVariableMap {
    ctx: Ctx;
  }
}

const app = new Hono();

const ctx: Ctx = {
  db: openProductionDb(),
  today: todayISO(),
};

app.use("*", async (c, next) => {
  c.set("ctx", ctx);
  await next();
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api/summary", summaryRoute);
app.route("/api/transactions", transactionsRoute);
app.route("/api/bundles", bundlesRoute);
app.route("/api/goals", goalsRoute);
app.route("/api/investments", investmentsRoute);
app.route("/api/networth", networthRoute);
app.route("/api/accounts", accountsRoute);
app.route("/api/portfolio", portfolioRoute);
app.route("/api/spending", spendingRoute);
app.route("/api/items", itemsRoute);
app.route("/api/sync", syncRoute);
app.route("/api/debt", debtRoute);
app.route("/api/cashflow", cashflowRoute);
app.route("/api/projections", projectionsRoute);
app.route("/api/advisor", advisorRoute);

const port = Number(process.env.PORT ?? 3001);
console.log(`[api] listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  // Sync endpoints spawn the TS CLI subprocess that can take minutes
  // (simplefin ~60s, zerion ~90s, alchemy fallback doubles it). Bun's
  // default 10s idle timeout kills the connection mid-subprocess and the
  // browser sees a 500 / fetch error. 255s is Bun's cap and fits every
  // per-parser sync comfortably.
  idleTimeout: 255,
};
