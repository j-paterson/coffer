import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { upsertScenarioWith, loadScenarioWith } from "../projections";
import type { Scenario } from "../../../../../packages/shared/types";
import { DEFAULT_COMPOSITION } from "../../../../../packages/shared/types";

let testDb: Database;

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.exec(`
    CREATE TABLE scenarios (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      notes                  TEXT,
      start_date             TEXT NOT NULL,
      horizon_months         INTEGER NOT NULL,
      baseline_return_pct    REAL NOT NULL,
      baseline_vol_pct       REAL NOT NULL,
      home_appreciation_pct  REAL NOT NULL,
      mc_enabled             INTEGER NOT NULL DEFAULT 0,
      mc_paths               INTEGER NOT NULL DEFAULT 5000,
      mc_seed                INTEGER,
      comparison_scenario_id TEXT,
      composition_json       TEXT,
      created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE scenario_events (
      scenario_id  TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      at_month     INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (scenario_id, seq)
    );
  `);
});

afterEach(() => { testDb.close(); });

const BASE_SCENARIO: Omit<Scenario, "id" | "name"> = {
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

test("round-trip: scenario without composition saves and loads with composition undefined", () => {
  const scenario: Scenario = { ...BASE_SCENARIO, name: "No composition" };
  const id = upsertScenarioWith(testDb, scenario);
  const loaded = loadScenarioWith(testDb, id);
  expect(loaded).not.toBeNull();
  expect(loaded!.composition).toBeUndefined();
});

test("round-trip: scenario with composition round-trips exactly", () => {
  const composition = {
    equity:    { ...DEFAULT_COMPOSITION.equity,    fraction: 0.6 },
    bond:      { ...DEFAULT_COMPOSITION.bond,      fraction: 0.4 },
    ordIncome: { ...DEFAULT_COMPOSITION.ordIncome, fraction: 0 },
  };
  const scenario: Scenario = { ...BASE_SCENARIO, name: "With composition", composition };
  const id = upsertScenarioWith(testDb, scenario);
  const loaded = loadScenarioWith(testDb, id);
  expect(loaded).not.toBeNull();
  expect(loaded!.composition).toEqual(composition);
  expect(loaded!.composition!.bond.fraction).toBeCloseTo(0.4, 10);
  expect(loaded!.composition!.equity.fraction).toBeCloseTo(0.6, 10);
});

test("round-trip: upsert updates composition on conflict", () => {
  const compositionV1 = {
    equity:    { ...DEFAULT_COMPOSITION.equity,    fraction: 0.8 },
    bond:      { ...DEFAULT_COMPOSITION.bond,      fraction: 0.2 },
    ordIncome: { ...DEFAULT_COMPOSITION.ordIncome, fraction: 0 },
  };
  const scenario: Scenario = { ...BASE_SCENARIO, name: "Updatable", composition: compositionV1 };
  const id = upsertScenarioWith(testDb, scenario);

  // Update with a different composition
  const compositionV2 = {
    equity:    { ...DEFAULT_COMPOSITION.equity,    fraction: 0.6 },
    bond:      { ...DEFAULT_COMPOSITION.bond,      fraction: 0.4 },
    ordIncome: { ...DEFAULT_COMPOSITION.ordIncome, fraction: 0 },
  };
  upsertScenarioWith(testDb, { ...scenario, id, composition: compositionV2 });
  const loaded = loadScenarioWith(testDb, id);
  expect(loaded!.composition!.bond.fraction).toBeCloseTo(0.4, 10);
});

test("round-trip: upsert clears composition when updated to undefined", () => {
  const scenario: Scenario = { ...BASE_SCENARIO, name: "Clearable", composition: { ...DEFAULT_COMPOSITION } };
  const id = upsertScenarioWith(testDb, scenario);
  upsertScenarioWith(testDb, { ...scenario, id, composition: undefined });
  const loaded = loadScenarioWith(testDb, id);
  expect(loaded!.composition).toBeUndefined();
});
