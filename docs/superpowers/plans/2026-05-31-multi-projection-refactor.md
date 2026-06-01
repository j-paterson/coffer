# Multi-projection refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `/projections` from a single HELOC page into a multi-projection shell with sub-routes for HELOC (live), Retirement (stub), and Mortgage (stub).

**Architecture:** Replace the flat `projections` route in `apps/web/src/main.tsx` with a nested `ProjectionsLayout` that renders a breadcrumb top nav + `<Outlet />`. Move all current HELOC components from `apps/web/src/routes/projections/` into `apps/web/src/routes/projections/heloc/` and reincarnate today's `Projections.tsx` body as `Heloc.tsx`. Add a `projection_kind` column to the server `scenarios` table so future projections can save without colliding. Stubs are minimal "Coming soon" pages driven by a shared `projectionRegistry.ts`.

**Tech Stack:** React 18, react-router-dom v7, TypeScript, vitest + @testing-library/react (client), Hono + bun:sqlite + bun:test (server), tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-31-multi-projection-design.md`

---

## File Inventory

### New files

- `db/migrations/054_projection_kind.sql` — add `projection_kind` column to scenarios
- `apps/web/src/routes/projections/_shell/projectionRegistry.ts` — single source of truth for nav + index
- `apps/web/src/routes/projections/_shell/ProjectionCard.tsx` — one card on the index
- `apps/web/src/routes/projections/_shell/ProjectionsIndex.tsx` — 3-card picker
- `apps/web/src/routes/projections/_shell/ProjectionsLayout.tsx` — breadcrumb top nav + Outlet + toolbar portal target
- `apps/web/src/routes/projections/heloc/Heloc.tsx` — body of today's Projections.tsx (with portal mount of SaveScenarioBar)
- `apps/web/src/routes/projections/retirement/Retirement.tsx` — stub page
- `apps/web/src/routes/projections/mortgage/Mortgage.tsx` — stub page
- `apps/web/src/routes/projections/_shell/__tests__/ProjectionsIndex.test.tsx` — smoke test
- `apps/web/src/routes/projections/_shell/__tests__/ProjectionsLayout.test.tsx` — smoke test

### Moved files (git mv from `apps/web/src/routes/projections/` to `apps/web/src/routes/projections/heloc/`)

`LoanCard.tsx`, `MarketCard.tsx`, `CompositionCard.tsx`, `TaxCard.tsx`, `StressCard.tsx`, `CompareCard.tsx`, `HeadlineCards.tsx`, `NetWorthChart.tsx`, `DeltaChart.tsx`, `TaxProfileModal.tsx`, `HomeSetupModal.tsx`, `SaveScenarioBar.tsx`, `AdvisorPanel.tsx`, `useScenario.ts`

### Modified files

- `apps/server/src/routes/projections.ts` — `upsertScenarioWith` / `loadScenarioWith` / GET `/` handle `projection_kind`
- `apps/server/src/routes/__tests__/projections.test.ts` — add tests for `projection_kind`
- `apps/web/src/main.tsx` — replace flat `projections` route with nested layout
- All moved HELOC files — bump `packages/shared/types` relative path from 5 levels to 6 levels

### Deleted files

- `apps/web/src/routes/Projections.tsx`

---

## Task Order Rationale

Server first (migration + plumbing + tests) so the data layer is honest before the UI changes ride on top. Then client shell (registry → card → index → layout). Then the HELOC move + Heloc.tsx + portal wiring. Then stubs and the route swap. Smoke tests last.

---

## Task 1: Add `projection_kind` column migration

**Files:**
- Create: `db/migrations/054_projection_kind.sql`

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/054_projection_kind.sql
--
-- Scope saved scenarios to a projection kind so future projections
-- (retirement, mortgage) can save their own scenarios without
-- colliding with HELOC's. Existing rows backfill as 'heloc'.

ALTER TABLE scenarios ADD COLUMN projection_kind TEXT NOT NULL DEFAULT 'heloc';
```

- [ ] **Step 2: Run server tests to confirm migrations still apply cleanly**

Run: `cd apps/server && bun test test/setup.test.ts`
Expected: PASS — `createTestCtx()` applies all migrations including 054 without error.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/054_projection_kind.sql
git commit -m "db: add projection_kind to scenarios"
```

---

## Task 2: Plumb `projection_kind` through scenarios CRUD

**Files:**
- Modify: `apps/server/src/routes/projections.ts`

The current `upsertScenarioWith` inserts 14 columns (`id`, `name`, `notes`, `start_date`, `horizon_months`, `baseline_return_pct`, `baseline_vol_pct`, `home_appreciation_pct`, `mc_enabled`, `mc_paths`, `mc_seed`, `comparison_scenario_id`, `composition_json`, `updated_at`). Add `projection_kind` as the 15th. Default to `'heloc'` when not provided on the input scenario so existing callers keep working. The list endpoint accepts an optional `?kind=` query param and filters when present.

- [ ] **Step 1: Add `projectionKind` field to `Scenario` type**

Edit `packages/shared/types.ts` to add `projectionKind?: "heloc" | "retirement" | "mortgage"` to the `Scenario` interface. Place it near `name`/`notes` (saved-scenario fields, not engine inputs).

```ts
export interface Scenario {
  // ...existing fields...
  /** Which projection page this scenario belongs to. Defaults to "heloc"
   *  for legacy scenarios (backfilled by migration 054). */
  projectionKind?: "heloc" | "retirement" | "mortgage";
  // ...rest...
}
```

- [ ] **Step 2: Update `upsertScenarioWith` to write `projection_kind`**

In `apps/server/src/routes/projections.ts`, modify the `INSERT INTO scenarios` SQL and `.run(...)` call inside `upsertScenarioWith` (currently lines 43–90). New version:

```ts
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
```

- [ ] **Step 3: Update `loadScenarioWith` to return `projectionKind`**

Extend the `SavedScenario` type (currently lines 36–41 of `projections.ts`) to include `projectionKind`, and add it to the returned object in `loadScenarioWith` (currently lines 92–122):

```ts
type SavedScenario = Pick<
  Scenario,
  "id" | "name" | "notes" | "startDate" | "horizonMonths"
  | "baselineReturnPct" | "baselineVolPct" | "homeAppreciationPct" | "mc" | "events"
  | "composition" | "projectionKind"
>;
```

In the returned object inside `loadScenarioWith`, add the field right before the closing brace:

```ts
  return {
    // ...existing fields...
    composition: r.composition_json ? JSON.parse(r.composition_json) : undefined,
    projectionKind: r.projection_kind ?? "heloc",
  };
```

- [ ] **Step 4: Add `?kind` filter to the GET list handler**

Replace the current GET handler (lines 131–139) with:

```ts
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
```

- [ ] **Step 5: Run server typecheck**

Run: `cd apps/server && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Run existing server tests to confirm nothing regressed**

Run: `cd apps/server && bun test src/routes/__tests__/projections.test.ts`
Expected: 4/4 pass (existing tests). They don't pass `projectionKind` so the `'heloc'` default kicks in.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/projections.ts packages/shared/types.ts
git commit -m "server: plumb projection_kind through scenarios CRUD"
```

---

## Task 3: Add server tests for `projection_kind`

**Files:**
- Modify: `apps/server/src/routes/__tests__/projections.test.ts`

The existing test file uses a hand-written `CREATE TABLE` for `scenarios` (lines 11–37). Add `projection_kind` to that schema so the new column is present, then add two tests: a round-trip test and (using a Hono app + `createTestCtx`) a filter test against the GET handler.

- [ ] **Step 1: Add `projection_kind` to the in-memory schema**

In `apps/server/src/routes/__tests__/projections.test.ts`, modify the `CREATE TABLE scenarios` block (lines 12–28) to add the new column. Replace lines 24–27 (the trailing columns) with:

```ts
      comparison_scenario_id TEXT,
      composition_json       TEXT,
      projection_kind        TEXT NOT NULL DEFAULT 'heloc',
      created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

- [ ] **Step 2: Write failing round-trip test for `projectionKind`**

Append to the end of `apps/server/src/routes/__tests__/projections.test.ts`:

```ts
test("round-trip: projectionKind defaults to 'heloc' when omitted", () => {
  const scenario: Scenario = { ...BASE_SCENARIO, name: "Defaulted" };
  const id = upsertScenarioWith(testDb, scenario);
  const loaded = loadScenarioWith(testDb, id);
  expect(loaded!.projectionKind).toBe("heloc");
});

test("round-trip: explicit projectionKind is preserved", () => {
  const scenario: Scenario = {
    ...BASE_SCENARIO,
    name: "Retirement scenario",
    projectionKind: "retirement",
  };
  const id = upsertScenarioWith(testDb, scenario);
  const loaded = loadScenarioWith(testDb, id);
  expect(loaded!.projectionKind).toBe("retirement");
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd apps/server && bun test src/routes/__tests__/projections.test.ts`
Expected: 6/6 pass (4 existing + 2 new).

- [ ] **Step 4: Write a Hono-mounted filter test (different file pattern)**

Create `apps/server/test/projectionsScenarioFilter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import projectionsRoute from "../src/routes/projections";
import { upsertScenarioWith } from "../src/routes/projections";
import { createTestCtx } from "./setup";
import type { Ctx } from "../src/ctx";
import type { Scenario } from "../../../packages/shared/types";

function makeApp(ctx: Ctx) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });
  app.route("/api/projections", projectionsRoute);
  return app;
}

const BASE: Omit<Scenario, "id" | "name"> = {
  startDate: "2026-04-01",
  horizonMonths: 360,
  baselineReturnPct: 0.065,
  baselineVolPct: 0.15,
  homeAppreciationPct: 0.03,
  mc: { enabled: false, paths: 5000, seed: 42 },
  initialHomeValue: 1_000_000,
  initialPortfolioValue: 500_000,
  monthlyIncome: 15_000,
  monthlyExpense: 9_000,
  tax: {
    marginalOrdinaryRate: 0.37,
    ltcgRate: 0.238,
    qualifiedDivRate: 0.238,
    ltcgElection: false,
    ordinaryInvestmentIncomeMonthly: 0,
  },
  events: [],
};

describe("GET /api/projections", () => {
  test("?kind=heloc returns only HELOC scenarios", async () => {
    const ctx = createTestCtx();
    upsertScenarioWith(ctx.db, { ...BASE, name: "H1", projectionKind: "heloc" });
    upsertScenarioWith(ctx.db, { ...BASE, name: "R1", projectionKind: "retirement" });
    upsertScenarioWith(ctx.db, { ...BASE, name: "H2", projectionKind: "heloc" });

    const app = makeApp(ctx);
    const res = await app.request("/api/projections?kind=heloc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenarios: { name: string }[] };
    const names = body.scenarios.map((s) => s.name).sort();
    expect(names).toEqual(["H1", "H2"]);
  });

  test("no kind param returns all scenarios", async () => {
    const ctx = createTestCtx();
    upsertScenarioWith(ctx.db, { ...BASE, name: "H1", projectionKind: "heloc" });
    upsertScenarioWith(ctx.db, { ...BASE, name: "R1", projectionKind: "retirement" });

    const app = makeApp(ctx);
    const res = await app.request("/api/projections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenarios: { name: string }[] };
    expect(body.scenarios.length).toBe(2);
  });
});
```

- [ ] **Step 5: Run the new test file**

Run: `cd apps/server && bun test test/projectionsScenarioFilter.test.ts`
Expected: 2/2 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/__tests__/projections.test.ts apps/server/test/projectionsScenarioFilter.test.ts
git commit -m "server: test projection_kind round-trip and filter"
```

---

## Task 4: Create projection registry

**Files:**
- Create: `apps/web/src/routes/projections/_shell/projectionRegistry.ts`

- [ ] **Step 1: Create the registry**

```ts
// apps/web/src/routes/projections/_shell/projectionRegistry.ts

export type ProjectionStatus = "ready" | "coming-soon";

export type ProjectionMeta = {
  slug: "heloc" | "retirement" | "mortgage";
  title: string;
  blurb: string;
  status: ProjectionStatus;
};

export const projections: ProjectionMeta[] = [
  {
    slug: "heloc",
    title: "HELOC",
    blurb: "Borrow against home equity to invest.",
    status: "ready",
  },
  {
    slug: "retirement",
    title: "Retirement",
    blurb: "Model retirement income and FIRE scenarios.",
    status: "coming-soon",
  },
  {
    slug: "mortgage",
    title: "Mortgage",
    blurb: "Compare payoff vs refinance options.",
    status: "coming-soon",
  },
];
```

- [ ] **Step 2: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/projections/_shell/projectionRegistry.ts
git commit -m "web: projection registry"
```

---

## Task 5: Create ProjectionCard

**Files:**
- Create: `apps/web/src/routes/projections/_shell/ProjectionCard.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/routes/projections/_shell/ProjectionCard.tsx

import { Link } from "react-router-dom";
import type { ProjectionMeta } from "./projectionRegistry";

export function ProjectionCard({ meta }: { meta: ProjectionMeta }) {
  const ready = meta.status === "ready";
  return (
    <Link
      to={`/projections/${meta.slug}`}
      className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-5 transition-colors hover:border-stone-300 hover:bg-stone-50"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-stone-900">{meta.title}</h3>
        {!ready && (
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
            Coming soon
          </span>
        )}
      </div>
      <p className="text-sm text-stone-600">{meta.blurb}</p>
      <div className="mt-auto text-sm font-medium text-stone-700">
        {ready ? "Configure →" : "Preview →"}
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: no errors (unused export is fine — consumers come in the next task).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/projections/_shell/ProjectionCard.tsx
git commit -m "web: ProjectionCard"
```

---

## Task 6: Create ProjectionsIndex

**Files:**
- Create: `apps/web/src/routes/projections/_shell/ProjectionsIndex.tsx`

- [ ] **Step 1: Create the index page**

```tsx
// apps/web/src/routes/projections/_shell/ProjectionsIndex.tsx

import { ProjectionCard } from "./ProjectionCard";
import { projections } from "./projectionRegistry";

export function ProjectionsIndex() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900">Projections</h1>
        <p className="text-sm text-stone-500">
          Model long-term financial decisions. Pick a projection to get started.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projections.map((p) => (
          <ProjectionCard key={p.slug} meta={p} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/projections/_shell/ProjectionsIndex.tsx
git commit -m "web: ProjectionsIndex picker"
```

---

## Task 7: Create ProjectionsLayout

**Files:**
- Create: `apps/web/src/routes/projections/_shell/ProjectionsLayout.tsx`

`ProjectionsLayout` renders the breadcrumb top nav and the `<Outlet />`. It also renders an empty `<div id="projection-toolbar" />` in the header row where each projection mounts its per-page toolbar (e.g. HELOC's SaveScenarioBar) via React portal. On the index page (root path) the breadcrumb collapses to just "Projections" and the per-projection nav is hidden.

- [ ] **Step 1: Create the layout**

```tsx
// apps/web/src/routes/projections/_shell/ProjectionsLayout.tsx

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { projections } from "./projectionRegistry";

export function ProjectionsLayout() {
  const location = useLocation();
  const onIndex =
    location.pathname === "/projections" || location.pathname === "/projections/";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3 border-b border-stone-200 pb-3">
        <NavLink
          to="/projections"
          end
          className={({ isActive }) =>
            `text-sm font-semibold ${isActive ? "text-stone-900" : "text-stone-700 hover:text-stone-900"}`
          }
        >
          Projections
        </NavLink>
        {!onIndex && (
          <>
            <span className="text-stone-400">/</span>
            <nav className="flex items-center gap-2 text-sm">
              {projections.map((p, i) => (
                <span key={p.slug} className="flex items-center gap-2">
                  {i > 0 && <span className="text-stone-300">·</span>}
                  <NavLink
                    to={`/projections/${p.slug}`}
                    className={({ isActive }) =>
                      isActive
                        ? "font-semibold text-stone-900"
                        : "text-stone-500 hover:text-stone-700"
                    }
                  >
                    {p.title}
                  </NavLink>
                </span>
              ))}
            </nav>
          </>
        )}
        <div id="projection-toolbar" className="ml-auto" />
      </header>
      <Outlet />
    </div>
  );
}
```

- [ ] **Step 2: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/projections/_shell/ProjectionsLayout.tsx
git commit -m "web: ProjectionsLayout with breadcrumb nav + toolbar portal target"
```

---

## Task 8: Move HELOC component files into `projections/heloc/`

**Files (moved):**
- `apps/web/src/routes/projections/LoanCard.tsx` → `apps/web/src/routes/projections/heloc/LoanCard.tsx`
- `apps/web/src/routes/projections/MarketCard.tsx` → `apps/web/src/routes/projections/heloc/MarketCard.tsx`
- `apps/web/src/routes/projections/CompositionCard.tsx` → `apps/web/src/routes/projections/heloc/CompositionCard.tsx`
- `apps/web/src/routes/projections/TaxCard.tsx` → `apps/web/src/routes/projections/heloc/TaxCard.tsx`
- `apps/web/src/routes/projections/StressCard.tsx` → `apps/web/src/routes/projections/heloc/StressCard.tsx`
- `apps/web/src/routes/projections/CompareCard.tsx` → `apps/web/src/routes/projections/heloc/CompareCard.tsx`
- `apps/web/src/routes/projections/HeadlineCards.tsx` → `apps/web/src/routes/projections/heloc/HeadlineCards.tsx`
- `apps/web/src/routes/projections/NetWorthChart.tsx` → `apps/web/src/routes/projections/heloc/NetWorthChart.tsx`
- `apps/web/src/routes/projections/DeltaChart.tsx` → `apps/web/src/routes/projections/heloc/DeltaChart.tsx`
- `apps/web/src/routes/projections/TaxProfileModal.tsx` → `apps/web/src/routes/projections/heloc/TaxProfileModal.tsx`
- `apps/web/src/routes/projections/HomeSetupModal.tsx` → `apps/web/src/routes/projections/heloc/HomeSetupModal.tsx`
- `apps/web/src/routes/projections/SaveScenarioBar.tsx` → `apps/web/src/routes/projections/heloc/SaveScenarioBar.tsx`
- `apps/web/src/routes/projections/AdvisorPanel.tsx` → `apps/web/src/routes/projections/heloc/AdvisorPanel.tsx`
- `apps/web/src/routes/projections/useScenario.ts` → `apps/web/src/routes/projections/heloc/useScenario.ts`

After the moves, each file gains one directory level, so any import that reached up to `packages/shared/types` via 5 `../` must become 6, and any import that reached `lib/LineChart` or `lib/privacy` etc. via 2 `../` must become 3.

- [ ] **Step 1: Move all files with git mv**

```bash
cd apps/web/src/routes/projections
mkdir -p heloc
git mv LoanCard.tsx MarketCard.tsx CompositionCard.tsx TaxCard.tsx \
  StressCard.tsx CompareCard.tsx HeadlineCards.tsx NetWorthChart.tsx \
  DeltaChart.tsx TaxProfileModal.tsx HomeSetupModal.tsx \
  SaveScenarioBar.tsx AdvisorPanel.tsx useScenario.ts heloc/
```

- [ ] **Step 2: Fix `packages/shared` imports (depth +1)**

The 13 files importing from `packages/shared` (everything except `CompareCard.tsx` and `HomeSetupModal.tsx`) currently use `"../../../../../packages/shared/types"`. After the move they need `"../../../../../../packages/shared/types"`.

Run, from repo root:

```bash
cd <repo-root>
sed -i 's|"../../../../../packages/shared/types"|"../../../../../../packages/shared/types"|g' \
  apps/web/src/routes/projections/heloc/*.tsx \
  apps/web/src/routes/projections/heloc/useScenario.ts
```

- [ ] **Step 3: Fix `lib/*` imports (depth +1)**

`NetWorthChart.tsx`, `DeltaChart.tsx`, and `AdvisorPanel.tsx` import from `"../../lib/..."`. After the move that becomes `"../../../lib/..."`. Run:

```bash
cd <repo-root>
sed -i 's|from "../../lib/|from "../../../lib/|g' \
  apps/web/src/routes/projections/heloc/NetWorthChart.tsx \
  apps/web/src/routes/projections/heloc/DeltaChart.tsx \
  apps/web/src/routes/projections/heloc/AdvisorPanel.tsx
```

- [ ] **Step 4: Run web typecheck to verify all imports resolved**

Run: `cd apps/web && bun run typecheck`
Expected: no errors related to module resolution. (There may be errors in `Projections.tsx` because it still imports from `./projections/*` instead of `./projections/heloc/*` — that's fixed in Task 9.)

- [ ] **Step 5: Verify with grep that no stale 5-level paths remain**

Run: `grep -rn '\.\./\.\./\.\./\.\./\.\./packages/shared' apps/web/src/routes/projections/heloc/`
Expected: no output.

Run: `grep -rn 'from "\.\./\.\./lib/' apps/web/src/routes/projections/heloc/`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/projections/heloc/
git commit -m "web: move HELOC projection files into projections/heloc/"
```

---

## Task 9: Create Heloc.tsx (replaces old Projections.tsx body)

**Files:**
- Create: `apps/web/src/routes/projections/heloc/Heloc.tsx`

Today's `apps/web/src/routes/Projections.tsx` is a single component called `Projections`. Re-incarnate it as `Heloc.tsx`, exporting `Heloc`. Header markup stays put; SaveScenarioBar still mounts here but renders through a React portal into the layout's `#projection-toolbar` slot so it sits in the header row.

- [ ] **Step 1: Create `Heloc.tsx`**

```tsx
// apps/web/src/routes/projections/heloc/Heloc.tsx

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useScenario } from "./useScenario";
import { LoanCard } from "./LoanCard";
import { MarketCard } from "./MarketCard";
import { CompositionCard } from "./CompositionCard";
import { TaxCard } from "./TaxCard";
import { StressCard } from "./StressCard";
import { CompareCard } from "./CompareCard";
import { HeadlineCards } from "./HeadlineCards";
import { NetWorthChart } from "./NetWorthChart";
import { DeltaChart } from "./DeltaChart";
import { TaxProfileModal } from "./TaxProfileModal";
import { HomeSetupModal } from "./HomeSetupModal";
import { SaveScenarioBar } from "./SaveScenarioBar";
import { AdvisorPanel } from "./AdvisorPanel";

export function Heloc() {
  const { prefill, scenario, setScenario, runResult, isPending } = useScenario();
  const qc = useQueryClient();
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setToolbarEl(document.getElementById("projection-toolbar"));
  }, []);

  if (prefill && !prefill.ok && prefill.requiresHome) {
    return <HomeSetupModal onSaved={() => qc.invalidateQueries({ queryKey: ["prefill"] })} />;
  }
  if (prefill && !prefill.ok && prefill.requiresTaxProfile) {
    return <TaxProfileModal onSaved={() => window.location.reload()} onCancel={() => {}} />;
  }
  if (!scenario || !runResult) {
    return <div className="text-sm text-stone-500">Loading projections…</div>;
  }

  return (
    <div className="flex h-full flex-col gap-6">
      {toolbarEl &&
        createPortal(
          <SaveScenarioBar scenario={scenario} onLoaded={(s) => setScenario(() => s)} />,
          toolbarEl,
        )}
      <div>
        <p className="text-sm text-stone-500">Model borrowing against home equity to invest.</p>
      </div>
      <div className="grid grid-cols-[320px_1fr] gap-6">
        <aside className="flex flex-col gap-3">
          <LoanCard scenario={scenario} onChange={setScenario} />
          <MarketCard scenario={scenario} onChange={setScenario} />
          <CompositionCard scenario={scenario} onChange={setScenario} />
          <TaxCard scenario={scenario} onChange={setScenario} />
          <StressCard scenario={scenario} onChange={setScenario} />
          <CompareCard />
        </aside>
        <section className="flex flex-col gap-4">
          <HeadlineCards summary={runResult.summary} />
          <NetWorthChart timeline={runResult.timeline} comparison={runResult.comparison} showMC={scenario.mc.enabled} startDate={scenario.startDate} />
          <DeltaChart timeline={runResult.timeline} comparison={runResult.comparison} startDate={scenario.startDate} />
          <AdvisorPanel scenario={scenario} runResult={runResult} />
          {isPending && <div className="text-xs text-stone-400">recomputing…</div>}
        </section>
      </div>
    </div>
  );
}
```

(Note: the inner `<h1>Projections</h1>` from the old file is removed because the layout breadcrumb already shows that title.)

- [ ] **Step 2: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: errors in the old `apps/web/src/routes/Projections.tsx` (imports `./projections/X` which no longer exist) — that file gets deleted in Task 13.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/projections/heloc/Heloc.tsx
git commit -m "web: Heloc.tsx mounts SaveScenarioBar via portal"
```

---

## Task 10: Update SaveScenarioBar to send `projection_kind=heloc`

**Files:**
- Modify: `apps/web/src/routes/projections/heloc/SaveScenarioBar.tsx`

Tag every save with `projectionKind: "heloc"` and filter the list call with `?kind=heloc`. Same component, two small edits.

- [ ] **Step 1: Update save and refresh to scope by kind**

In `apps/web/src/routes/projections/heloc/SaveScenarioBar.tsx`, replace the `save` and `refresh` functions (currently lines 7–19) with:

```tsx
  async function save() {
    const res = await fetch("/api/projections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: { ...scenario, name, projectionKind: "heloc" as const },
      }),
    }).then((r) => r.json());
    await refresh();
    return res;
  }
  async function refresh() {
    const list = await fetch("/api/projections?kind=heloc").then((r) => r.json());
    setSaved(list.scenarios);
  }
```

- [ ] **Step 2: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: no new errors in this file (Projections.tsx errors persist; cleared in Task 13).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/projections/heloc/SaveScenarioBar.tsx
git commit -m "web: SaveScenarioBar scopes saves to projection_kind=heloc"
```

---

## Task 11: Create stub Retirement and Mortgage pages

**Files:**
- Create: `apps/web/src/routes/projections/retirement/Retirement.tsx`
- Create: `apps/web/src/routes/projections/mortgage/Mortgage.tsx`

- [ ] **Step 1: Create Retirement stub**

```tsx
// apps/web/src/routes/projections/retirement/Retirement.tsx

import { projections } from "../_shell/projectionRegistry";

export function Retirement() {
  const meta = projections.find((p) => p.slug === "retirement")!;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-stone-900">{meta.title}</h2>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
          Coming soon
        </span>
      </div>
      <p className="text-sm text-stone-500">{meta.blurb}</p>
      <p className="text-sm text-stone-600">
        This projection is not built yet. It will let you model contribution
        accounts, withdrawal phases, and tax treatment across pre-tax and Roth
        buckets.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Create Mortgage stub**

```tsx
// apps/web/src/routes/projections/mortgage/Mortgage.tsx

import { projections } from "../_shell/projectionRegistry";

export function Mortgage() {
  const meta = projections.find((p) => p.slug === "mortgage")!;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-stone-900">{meta.title}</h2>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
          Coming soon
        </span>
      </div>
      <p className="text-sm text-stone-500">{meta.blurb}</p>
      <p className="text-sm text-stone-600">
        This projection is not built yet. It will compare aggressive payoff,
        refinance, and as-scheduled paths against each other.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: only the same Projections.tsx error from before; both new files type-check cleanly.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/projections/retirement/Retirement.tsx \
        apps/web/src/routes/projections/mortgage/Mortgage.tsx
git commit -m "web: Retirement and Mortgage stub pages"
```

---

## Task 12: Wire new routes in `main.tsx`

**Files:**
- Modify: `apps/web/src/main.tsx`

Swap the flat `projections` entry for a nested layout with three children (heloc, retirement, mortgage) plus an index.

- [ ] **Step 1: Update imports and route table**

Replace line 28 (`import { Projections } from "./routes/Projections";`) with:

```ts
import { ProjectionsLayout } from "./routes/projections/_shell/ProjectionsLayout";
import { ProjectionsIndex } from "./routes/projections/_shell/ProjectionsIndex";
import { Heloc } from "./routes/projections/heloc/Heloc";
import { Retirement } from "./routes/projections/retirement/Retirement";
import { Mortgage } from "./routes/projections/mortgage/Mortgage";
```

Replace line 44 (`{ path: "projections", element: <Projections /> },`) with:

```ts
      {
        path: "projections",
        element: <ProjectionsLayout />,
        children: [
          { index: true, element: <ProjectionsIndex /> },
          { path: "heloc", element: <Heloc /> },
          { path: "retirement", element: <Retirement /> },
          { path: "mortgage", element: <Mortgage /> },
        ],
      },
```

- [ ] **Step 2: Run web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: errors limited to `apps/web/src/routes/Projections.tsx` (orphaned file, imports `./projections/X` paths that moved). Cleared in Task 13.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/main.tsx
git commit -m "web: nested routes under /projections"
```

---

## Task 13: Delete old `Projections.tsx`

**Files:**
- Delete: `apps/web/src/routes/Projections.tsx`

- [ ] **Step 1: Confirm no references remain**

Run: `grep -rn "routes/Projections" apps/web/src/`
Expected: no output (the only consumer was `main.tsx`, updated in Task 12).

- [ ] **Step 2: Delete**

```bash
git rm apps/web/src/routes/Projections.tsx
```

- [ ] **Step 3: Run full web typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Run full server typecheck**

Run: `cd apps/server && bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "web: drop legacy Projections.tsx"
```

---

## Task 14: Client smoke tests

**Files:**
- Create: `apps/web/src/routes/projections/_shell/__tests__/ProjectionsIndex.test.tsx`
- Create: `apps/web/src/routes/projections/_shell/__tests__/ProjectionsLayout.test.tsx`

Two thin tests. They verify the index renders one link per projection and the layout shows the breadcrumb nav on sub-routes / hides it on the index.

- [ ] **Step 1: Write the ProjectionsIndex test**

```tsx
// apps/web/src/routes/projections/_shell/__tests__/ProjectionsIndex.test.tsx

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { ProjectionsIndex } from "../ProjectionsIndex";
import { projections } from "../projectionRegistry";

describe("ProjectionsIndex", () => {
  test("renders one card per projection", () => {
    render(
      <MemoryRouter>
        <ProjectionsIndex />
      </MemoryRouter>,
    );
    for (const p of projections) {
      expect(screen.getByText(p.title)).toBeInTheDocument();
      expect(screen.getByText(p.blurb)).toBeInTheDocument();
    }
  });

  test("only ready projections lack a 'Coming soon' badge", () => {
    render(
      <MemoryRouter>
        <ProjectionsIndex />
      </MemoryRouter>,
    );
    const badges = screen.getAllByText("Coming soon");
    const expected = projections.filter((p) => p.status === "coming-soon").length;
    expect(badges.length).toBe(expected);
  });
});
```

- [ ] **Step 2: Write the ProjectionsLayout test**

```tsx
// apps/web/src/routes/projections/_shell/__tests__/ProjectionsLayout.test.tsx

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { ProjectionsLayout } from "../ProjectionsLayout";

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projections" element={<ProjectionsLayout />}>
          <Route index element={<div>INDEX</div>} />
          <Route path="heloc" element={<div>HELOC</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectionsLayout", () => {
  test("hides the per-projection nav on the index", () => {
    mount("/projections");
    expect(screen.getByText("INDEX")).toBeInTheDocument();
    expect(screen.queryByText("HELOC")).not.toBeInTheDocument();
  });

  test("shows the per-projection nav on a sub-route", () => {
    mount("/projections/heloc");
    expect(screen.getAllByText("HELOC").length).toBeGreaterThan(0);
    expect(screen.getByText("Retirement")).toBeInTheDocument();
    expect(screen.getByText("Mortgage")).toBeInTheDocument();
  });

  test("exposes a #projection-toolbar portal target", () => {
    mount("/projections/heloc");
    expect(document.getElementById("projection-toolbar")).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `cd apps/web && bun run test`
Expected: 5/5 new tests pass (2 in ProjectionsIndex.test.tsx, 3 in ProjectionsLayout.test.tsx).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/projections/_shell/__tests__/
git commit -m "web: smoke tests for ProjectionsIndex and ProjectionsLayout"
```

---

## Task 15: Manual end-to-end verification

**Files:** none

The unit tests don't exercise full routing + HELOC rendering. A 30-second manual pass confirms the refactor didn't break the running app.

- [ ] **Step 1: Start the dev stack (server + web)**

From repo root, in two terminals (or use existing background processes):
```bash
cd apps/server && bun run dev
cd apps/web && bun run dev
```

Server should listen on `:3001`, web on `:5173`.

- [ ] **Step 2: Visit `/projections` and confirm the index**

Open `http://localhost:5173/projections`. Expected: header reads "Projections"; three cards render (HELOC, Retirement, Mortgage); Retirement and Mortgage cards show "Coming soon" badges; HELOC card shows "Configure →".

- [ ] **Step 3: Click HELOC and confirm the sandbox works**

Click the HELOC card. URL becomes `/projections/heloc`. The full HELOC sandbox renders (LoanCard, MarketCard, charts, etc.) exactly as before. SaveScenarioBar renders in the header bar (portal slot). If no home is configured, HomeSetupModal renders instead — confirm it still saves.

- [ ] **Step 4: Click Retirement and Mortgage**

Click "Retirement" in the breadcrumb. URL becomes `/projections/retirement`. Stub page renders with title + blurb + "Coming soon" badge. Same for Mortgage.

- [ ] **Step 5: Click "Projections" in the breadcrumb**

Returns to the index page.

- [ ] **Step 6: Save a HELOC scenario, navigate away, navigate back, load it**

On `/projections/heloc`, type a scenario name and save. Click "My scenarios" → confirm it appears. Navigate to `/projections`, then back to `/projections/heloc`. Click "My scenarios" again → the saved scenario still appears (proves `?kind=heloc` filter works end-to-end).

---

## Self-Review

(Filled in after the plan is written; if issues are found, fix inline.)

**Spec coverage:**
- Sub-routes: Task 12 wires them.
- ProjectionsLayout with breadcrumb nav + toolbar portal: Task 7.
- ProjectionsIndex picker with 3 cards: Tasks 5–6.
- Projection registry as single source of truth: Task 4.
- Move HELOC files unchanged: Task 8.
- Heloc.tsx replacing Projections.tsx body, mounting SaveScenarioBar via portal: Task 9.
- Stubs render real pages, not redirects: Task 11.
- Scenario storage `projection_kind` column + plumbing + filter: Tasks 1–3.
- SaveScenarioBar sends `kind=heloc`: Task 10.
- Delete old Projections.tsx: Task 13.
- Tests for the new column (server) and new shell components (client): Tasks 3, 14.
- Manual e2e check: Task 15.

No gaps.

**Placeholder scan:** none ("Coming soon" is intentional content).

**Type consistency:** `projectionKind` is the camelCase TS field; `projection_kind` is the snake_case DB column; both names are stable across all tasks. `ProjectionMeta.slug` is the string-literal union and matches the route paths.
