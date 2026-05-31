# Multi-projection refactor — design

## Goal

Turn `/projections` from a single HELOC sandbox into a multi-projection system. Phase 1 of an iterative build: introduce the shell (sub-routes, picker, top nav), migrate the existing HELOC projection into its new home unchanged, and add real placeholder pages for two future projection types (Retirement, Mortgage). Retirement and Mortgage engines are explicitly out of scope here — they will each get their own spec/plan/build cycle later.

## Current state

- One projection: HELOC (borrow against home equity to invest).
- Lives at `/projections`, rendered by `apps/web/src/routes/Projections.tsx`.
- Server endpoints under `/api/projections/*` are all HELOC-specific (prefill, run, home setup, scenarios CRUD).
- Saved scenarios live in the `scenarios` table (migration 038) and are implicitly HELOC.

## Scope (Phase 1)

In scope:
- Restructure routing under `/projections` to support sub-routes.
- New `ProjectionsLayout` (shared shell — top nav, slot for the projection's save/load bar).
- New `ProjectionsIndex` (picker page — three cards).
- Move the current HELOC UI from `routes/Projections.tsx` into `routes/projections/heloc/Heloc.tsx`, along with every HELOC-specific component currently living in `routes/projections/`. Behavior unchanged.
- Stub pages for Retirement and Mortgage that render real content ("Coming soon" + one-line preview) — they participate in the top nav but have no inputs, no engine, no save/load.
- Scope the existing `scenarios` table to a projection kind so future projections can save without colliding.

Out of scope:
- Retirement projection design or implementation.
- Mortgage projection design or implementation.
- Renaming server endpoints. The existing `/api/projections/*` endpoints stay as-is for Phase 1 because they're all HELOC; namespacing under `/api/projections/heloc/*` happens when the second engine ships.
- Any change to HELOC behavior, inputs, or charts.

## Architecture

### Route structure

`apps/web/src/main.tsx` swaps the flat `projections` route for a nested layout:

```
/projections                  → ProjectionsLayout > ProjectionsIndex
/projections/heloc            → ProjectionsLayout > Heloc
/projections/retirement       → ProjectionsLayout > Retirement (stub)
/projections/mortgage         → ProjectionsLayout > Mortgage (stub)
```

`ProjectionsLayout` renders the breadcrumb-style top nav and an `<Outlet />`. The layout component knows nothing about the individual projections — it just provides the chrome.

### File layout

```
apps/web/src/routes/projections/
  _shell/
    ProjectionsLayout.tsx     # breadcrumb header + Outlet
    ProjectionsIndex.tsx      # 3-card picker (rendered at /projections)
    ProjectionCard.tsx        # one card on the index
    projectionRegistry.ts     # single source of truth for nav + index
  heloc/
    Heloc.tsx                 # body of today's Projections.tsx
    LoanCard.tsx
    MarketCard.tsx
    CompositionCard.tsx
    TaxCard.tsx
    StressCard.tsx
    CompareCard.tsx
    HeadlineCards.tsx
    NetWorthChart.tsx
    DeltaChart.tsx
    TaxProfileModal.tsx
    HomeSetupModal.tsx
    SaveScenarioBar.tsx
    AdvisorPanel.tsx
    useScenario.ts
  retirement/
    Retirement.tsx            # stub
  mortgage/
    Mortgage.tsx              # stub
```

`apps/web/src/routes/Projections.tsx` is deleted.

The existing files directly under `routes/projections/` (LoanCard, MarketCard, etc.) move into `routes/projections/heloc/`. Imports inside those files keep their relative paths; the only call sites that change are the imports inside the new `Heloc.tsx` (which point to `./LoanCard` etc., same as before) and the route wiring in `main.tsx`.

### Projection registry

`projectionRegistry.ts` exports a single array used by both the top nav (in `ProjectionsLayout`) and the index (in `ProjectionsIndex`). Keeping this in one place means adding a future projection means editing one file plus adding the route.

```ts
export type ProjectionStatus = "ready" | "coming-soon";

export type ProjectionMeta = {
  slug: "heloc" | "retirement" | "mortgage";
  title: string;          // "HELOC"
  blurb: string;          // one-line description for the index card
  status: ProjectionStatus;
};

export const projections: ProjectionMeta[] = [
  { slug: "heloc",      title: "HELOC",
    blurb: "Borrow against home equity to invest.",
    status: "ready" },
  { slug: "retirement", title: "Retirement",
    blurb: "Model retirement income and FIRE scenarios.",
    status: "coming-soon" },
  { slug: "mortgage",   title: "Mortgage",
    blurb: "Compare payoff vs refinance options.",
    status: "coming-soon" },
];
```

### Top nav

Breadcrumb-style: `Projections / HELOC · Retirement · Mortgage`. The label "Projections" is always a link back to the index. The active projection (matched against the current path) is bolded; siblings are muted; coming-soon items are still clickable (they navigate to the stub page).

The layout also exposes a portal target where each projection can mount its own per-projection toolbar (e.g. HELOC's `SaveScenarioBar`). `ProjectionsLayout` renders a `<div id="projection-toolbar" />` in the header row, and `Heloc.tsx` mounts `SaveScenarioBar` into that target via React portal (`createPortal`). Stubs don't mount anything, leaving the slot empty. This avoids passing the toolbar through router context and keeps each projection's UI self-contained.

### Index page

A simple grid of three `ProjectionCard`s. Each card shows title + blurb (e.g. "HELOC" / "Borrow against home equity to invest."). Ready cards show a primary "Configure" button linking to the sub-route. Coming-soon cards show a muted "Coming soon" badge and are themselves clickable (linking to the stub).

### Stub pages

`Retirement.tsx` and `Mortgage.tsx` are nearly identical:

```tsx
<div className="flex flex-col gap-3">
  <h1 className="text-2xl font-semibold text-stone-900">{title}</h1>
  <p className="text-sm text-stone-500">{blurb}</p>
  <span className="...badge...">Coming soon</span>
</div>
```

They import their title/blurb from the registry to stay in sync.

### Scenario storage scoping

Add a `projection_kind TEXT NOT NULL DEFAULT 'heloc'` column to the `scenarios` table via a new migration. The default backfills existing rows as HELOC scenarios.

- `SaveScenarioBar` (now under `heloc/`) sends `projection_kind: "heloc"` on save.
- The list endpoint filters by `projection_kind`; HELOC's bar requests `?kind=heloc`.
- Server-side: the scenarios CRUD route accepts the new field and adds it to both the insert and the select-filter. The HTTP request shape gains `projection_kind` (required on create, optional on list — defaults to the requesting projection).

This is the minimum work to keep the schema honest as soon as a second projection ships. No client behavior change for HELOC users.

## Data flow

Nothing changes about how HELOC fetches prefill, runs scenarios, or saves. The Phase 1 refactor is exclusively about layout and routing on the client and the one schema column on the server.

## Error handling

- Unknown sub-routes under `/projections/*` (e.g. `/projections/garbage`): handled by react-router's default — falls back to the parent layout with an empty Outlet. Acceptable; not worth adding a custom 404 in Phase 1.
- The HELOC prefill gates (`requiresHome`, `requiresTaxProfile`) keep working unchanged — they live inside `Heloc.tsx` and render the same modals as today.

## Testing

- **Server**: existing tests (`projectionsHome.test.ts`, prefill tests, scenarios CRUD tests) must still pass. Add tests for the new `projection_kind` column: a scenario saved with `kind=heloc` is returned when listing with `kind=heloc`, and the migration backfills existing rows as `heloc`.
- **Client**: no client test infra exists in this repo for routes (per repo inspection). Phase 1 verification is manual: navigate to `/projections`, see three cards; click HELOC, see the full sandbox unchanged; click Retirement/Mortgage, see the stub. The TypeScript build (`bun run -F @coffer/web typecheck` or equivalent) is the regression net for the refactor.

## Migration & backwards compatibility

- One DB migration adds the `projection_kind` column with a `'heloc'` default. Existing rows backfill automatically. Safe to roll forward; no rollback plan needed (column is additive).
- No data loss possible — the refactor doesn't touch existing scenario data.
- Bookmarks to `/projections` continue to work; they now land on the index page instead of the HELOC sandbox. Anyone who specifically bookmarked the HELOC sandbox will need to re-bookmark `/projections/heloc`. Acceptable for a pre-public app.

## Open questions

None. All design questions resolved during the brainstorming conversation.
