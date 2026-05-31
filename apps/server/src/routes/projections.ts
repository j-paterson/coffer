import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Ctx } from "../ctx";
import { run } from "../lib/projection";
import { buildPrefill } from "../lib/projection/prefill";
import { suggestTaxProfile } from "../lib/projection/tax-suggest";
import type { Scenario, ProjectionRunResponse, PrefillResponse, FilingStatus, TaxSuggestResponse } from "../../../../packages/shared/types";

const route = new Hono();

route.get("/prefill", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const out: PrefillResponse = buildPrefill(ctx.db);
  return c.json(out);
});

route.post("/run", async (c) => {
  const body = (await c.req.json()) as { scenario: Scenario; compareTo?: Scenario };
  const result = run(body.scenario, body.compareTo);
  const resp: ProjectionRunResponse = result;
  return c.json(resp);
});


type SavedSummaryRow = {
  id: string;
  name: string;
  updated_at: string;
};

// Returns only the fields stored in the scenarios + scenario_events tables.
// Live ledger-derived fields (initialHomeValue, portfolio, income, expense,
// tax) are intentionally omitted — callers spread this over the current
// prefill so saved scenarios don't pin stale numbers from the save moment.
type SavedScenario = Pick<
  Scenario,
  "id" | "name" | "notes" | "startDate" | "horizonMonths"
  | "baselineReturnPct" | "baselineVolPct" | "homeAppreciationPct" | "mc" | "events"
  | "composition" | "projectionKind"
>;

export function upsertScenarioWith(database: Database, scenario: Scenario): string {
  const id = scenario.id ?? randomUUID();
  const name = scenario.name ?? `Scenario ${new Date().toISOString().slice(0, 10)}`;
  const projectionKind = scenario.projectionKind ?? "heloc";
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO scenarios (id, name, notes, start_date, horizon_months,
          baseline_return_pct, baseline_vol_pct, home_appreciation_pct,
          mc_enabled, mc_paths, mc_seed, comparison_scenario_id, composition_json,
          projection_kind, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, notes=excluded.notes, start_date=excluded.start_date,
           horizon_months=excluded.horizon_months,
           baseline_return_pct=excluded.baseline_return_pct,
           baseline_vol_pct=excluded.baseline_vol_pct,
           home_appreciation_pct=excluded.home_appreciation_pct,
           mc_enabled=excluded.mc_enabled, mc_paths=excluded.mc_paths,
           mc_seed=excluded.mc_seed, comparison_scenario_id=excluded.comparison_scenario_id,
           composition_json=excluded.composition_json,
           projection_kind=excluded.projection_kind,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        name,
        scenario.notes ?? null,
        scenario.startDate,
        scenario.horizonMonths,
        scenario.baselineReturnPct,
        scenario.baselineVolPct,
        scenario.homeAppreciationPct,
        scenario.mc.enabled ? 1 : 0,
        scenario.mc.paths,
        scenario.mc.seed ?? null,
        null,
        scenario.composition !== undefined ? JSON.stringify(scenario.composition) : null,
        projectionKind,
        now,
      );
    database.prepare(`DELETE FROM scenario_events WHERE scenario_id = ?`).run(id);
    const insert = database.prepare(
      `INSERT INTO scenario_events (scenario_id, seq, kind, at_month, payload_json) VALUES (?, ?, ?, ?, ?)`,
    );
    scenario.events.forEach((ev, i) => {
      insert.run(id, i, ev.kind, ev.atMonth, JSON.stringify(ev.payload));
    });
  })();
  return id;
}

export function loadScenarioWith(database: Database, id: string): SavedScenario | null {
  const r = database
    .query<any, [string]>(`SELECT * FROM scenarios WHERE id = ?`)
    .get(id);
  if (!r) return null;
  const events = database
    .query<any, [string]>(`SELECT kind, at_month, payload_json FROM scenario_events WHERE scenario_id = ? ORDER BY seq`)
    .all(id)
    .map((row) => ({
      kind: row.kind,
      atMonth: row.at_month,
      payload: JSON.parse(row.payload_json),
    }));
  return {
    id: r.id,
    name: r.name,
    notes: r.notes ?? undefined,
    startDate: r.start_date,
    horizonMonths: r.horizon_months,
    baselineReturnPct: r.baseline_return_pct,
    baselineVolPct: r.baseline_vol_pct,
    homeAppreciationPct: r.home_appreciation_pct,
    mc: {
      enabled: r.mc_enabled === 1,
      paths: r.mc_paths,
      seed: r.mc_seed ?? undefined,
    },
    events,
    composition: r.composition_json ? JSON.parse(r.composition_json) : undefined,
    projectionKind: r.projection_kind ?? "heloc",
  };
}

route.post("/", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const body = (await c.req.json()) as { scenario: Scenario };
  const id = upsertScenarioWith(ctx.db, body.scenario);
  return c.json({ id });
});

route.get("/", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const kind = c.req.query("kind");
  const rows = kind
    ? ctx.db
        .query<SavedSummaryRow, [string]>(
          `SELECT id, name, updated_at FROM scenarios WHERE projection_kind = ? ORDER BY updated_at DESC`,
        )
        .all(kind)
    : ctx.db
        .query<SavedSummaryRow, []>(
          `SELECT id, name, updated_at FROM scenarios ORDER BY updated_at DESC`,
        )
        .all();
  return c.json({ scenarios: rows });
});

route.get("/tax-suggest", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const status = c.req.query("status");
  if (status !== "single" && status !== "mfj" && status !== "hoh") {
    return c.json({ error: "invalid status" }, 400);
  }
  const incomeRaw = c.req.query("income");
  const annualIncome = incomeRaw !== undefined ? Number(incomeRaw) : undefined;
  if (annualIncome !== undefined && (!Number.isFinite(annualIncome) || annualIncome < 0)) {
    return c.json({ error: "invalid income" }, 400);
  }
  const out: TaxSuggestResponse = suggestTaxProfile(ctx.db, {
    filingStatus: status as FilingStatus,
    ...(annualIncome !== undefined ? { annualIncome } : {}),
  });
  return c.json(out);
});

route.get("/:id", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const s = loadScenarioWith(ctx.db, c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json({ scenario: s });
});

route.delete("/:id", (c) => {
  const ctx = c.get("ctx") as Ctx;
  ctx.db.prepare(`DELETE FROM scenarios WHERE id = ?`).run(c.req.param("id"));
  return c.json({ ok: true });
});

// Inline home / mortgage setup so users can configure Projections without
// importing from an external aggregator. Upserts a manual real-estate
// account that detectHome() finds; optionally creates a paired mortgage
// account + debt_terms row that detectMortgage() picks up via display_name.
route.post("/home", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const body = (await c.req.json()) as {
    homeValue: number;
    mortgage?: { balance: number; apr: number; monthlyPayment?: number };
  };
  if (!Number.isFinite(body.homeValue) || body.homeValue <= 0) {
    return c.json({ error: "homeValue must be a positive number" }, 400);
  }
  if (body.mortgage) {
    const { balance, apr } = body.mortgage;
    if (!Number.isFinite(balance) || balance < 0) {
      return c.json({ error: "mortgage balance must be a non-negative number" }, 400);
    }
    if (!Number.isFinite(apr) || apr < 0 || apr > 1) {
      return c.json({ error: "mortgage apr must be a decimal between 0 and 1" }, 400);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO accounts (id, display_name, institution, type, mode, active)
         VALUES ('manual:property:home', 'Primary residence', 'Manual', 'real_estate', 'manual', 1)
         ON CONFLICT(id) DO UPDATE SET active = 1, merged_into = NULL`,
      )
      .run();
    ctx.db
      .prepare(
        `INSERT INTO balance_assertions (account_id, as_of, expected_usd, source)
         VALUES ('manual:property:home', ?, ?, 'manual')
         ON CONFLICT(account_id, as_of, source) DO UPDATE SET expected_usd = excluded.expected_usd`,
      )
      .run(today, body.homeValue);
    if (body.mortgage) {
      ctx.db
        .prepare(
          `INSERT INTO accounts (id, display_name, institution, type, mode, active)
           VALUES ('manual:mortgage:home', 'Home Mortgage', 'Manual', 'manual', 'manual', 1)
           ON CONFLICT(id) DO UPDATE SET active = 1, merged_into = NULL`,
        )
        .run();
      ctx.db
        .prepare(
          `INSERT INTO balance_assertions (account_id, as_of, expected_usd, source)
           VALUES ('manual:mortgage:home', ?, ?, 'manual')
           ON CONFLICT(account_id, as_of, source) DO UPDATE SET expected_usd = excluded.expected_usd`,
        )
        .run(today, -Math.abs(body.mortgage.balance));
      const minPmtPct =
        body.mortgage.monthlyPayment && body.mortgage.balance > 0
          ? body.mortgage.monthlyPayment / body.mortgage.balance
          : 0.005;
      ctx.db
        .prepare(
          `INSERT INTO debt_terms (account_id, apr, min_payment_pct, min_payment_floor)
           VALUES ('manual:mortgage:home', ?, ?, 0)
           ON CONFLICT(account_id) DO UPDATE SET
             apr = excluded.apr,
             min_payment_pct = excluded.min_payment_pct,
             min_payment_floor = excluded.min_payment_floor,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(body.mortgage.apr, minPmtPct);
    }
  })();
  return c.json({ ok: true });
});

route.post("/tax-profile", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const body = (await c.req.json()) as any;
  ctx.db.prepare(
    `INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate, ltcg_election, ordinary_investment_income_monthly)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       marginal_ordinary_rate=excluded.marginal_ordinary_rate,
       ltcg_rate=excluded.ltcg_rate,
       qualified_div_rate=excluded.qualified_div_rate,
       ltcg_election=excluded.ltcg_election,
       ordinary_investment_income_monthly=excluded.ordinary_investment_income_monthly,
       updated_at=CURRENT_TIMESTAMP`
  ).run(body.marginalOrdinaryRate, body.ltcgRate, body.qualifiedDivRate, body.ltcgElection ? 1 : 0, body.ordinaryInvestmentIncomeMonthly);
  return c.json({ ok: true });
});

export default route;
