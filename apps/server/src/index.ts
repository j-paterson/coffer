import { Hono } from "hono";
import cashflowRoute from "./routes/cashflow";
import debtRoute from "./routes/debt";
import itemsRoute from "./routes/items";
import investmentsRoute from "./routes/investments";
import networthV2Route from "./routes/networth_v2";
import accountsV2Route from "./routes/accounts_v2";
import portfolioV2Route from "./routes/portfolio_v2";
import spendingV2Route from "./routes/spending_v2";
import summaryRoute from "./routes/summary";
import syncRoute from "./routes/sync";
import transactionsV2Route from "./routes/transactions_v2";
import bundlesRoute from "./routes/bundles";
import goalsRoute from "./routes/goals";
import projectionsRoute from "./routes/projections";
import advisorRoute from "./routes/advisor";
import { openProductionDb } from "./db";
import { todayISO } from "@coffer/ledger/walker";
import type { Ctx } from "./ctx";

declare module "hono" {
  interface ContextVariableMap {
    ctx: Ctx;
  }
}

const app = new Hono();

// TODO(oss): load finance.config.ts at startup and populate walkerConfig.
// The `walker` section of FinanceConfigInput (see packages/config/src/index.ts)
// carries networthFloor and assetOnlyTypes as plain strings/arrays; convert
// assetOnlyTypes to a Set<string> before assigning to ctx.walkerConfig.
// Use the same dynamic-import pattern as apps/cli/src/config/load.ts.
// Until then, walkerConfig is undefined and the walker uses its built-in
// defaults (no floor, standard asset-only type set) — correct for most users.
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
app.route("/api/transactions", transactionsV2Route);
app.route("/api/bundles", bundlesRoute);
app.route("/api/goals", goalsRoute);
app.route("/api/v2/investments", investmentsRoute);
app.route("/api/v2/networth", networthV2Route);
app.route("/api/v2/accounts", accountsV2Route);
app.route("/api/v2/portfolio", portfolioV2Route);
app.route("/api/v2/spending", spendingV2Route);
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
