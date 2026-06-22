import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { buildPrefill, estimateBondSleeve } from "../prefill";

let testDb: Database;

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, institution TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', active INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'manual', merged_into TEXT, display_name_override TEXT);
    CREATE TABLE balance_assertions (account_id TEXT NOT NULL, as_of TEXT NOT NULL, expected_usd REAL NOT NULL, source TEXT NOT NULL, source_file TEXT, PRIMARY KEY (account_id, as_of, source));
    CREATE TABLE debt_terms (account_id TEXT PRIMARY KEY, apr REAL NOT NULL, min_payment_pct REAL, min_payment_floor REAL, promo_balance REAL, promo_apr REAL, promo_expires_at TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE positions (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, symbol TEXT NOT NULL, chain TEXT, contract_address TEXT, asset_class TEXT);
    CREATE TABLE position_snapshots (position_id INTEGER NOT NULL, as_of TEXT NOT NULL, quantity REAL, value_usd REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (position_id, as_of, source));
    CREATE TABLE cashflow_settings (id INTEGER PRIMARY KEY CHECK (id = 1), monthly_income REAL, monthly_required_expense REAL, pay_frequency TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE tax_profile (id INTEGER PRIMARY KEY CHECK (id = 1), marginal_ordinary_rate REAL NOT NULL, ltcg_rate REAL NOT NULL, qualified_div_rate REAL NOT NULL, ltcg_election INTEGER NOT NULL DEFAULT 0, ordinary_investment_income_monthly REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
});

afterEach(() => { testDb.close(); });

function seedHome(db: Database, value: number, name = "Home") {
  db.prepare("INSERT INTO accounts (id, display_name, institution, type, mode) VALUES ('home1', ?, 'manual-entry', 'real_estate', 'manual')").run(name);
  db.prepare("INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES ('home1', '2026-04-01', ?, 'manual')").run(value);
}

test("no home → requiresHome: true", () => {
  const r = buildPrefill(testDb);
  if (r.ok) throw new Error("expected requiresHome");
  expect(r.requiresHome).toBe(true);
});

test("home present, no tax profile → requiresTaxProfile: true", () => {
  seedHome(testDb, 1_000_000);
  const r = buildPrefill(testDb);
  if (r.ok) throw new Error("expected requiresTaxProfile");
  expect(r.requiresTaxProfile).toBe(true);
});

test("home + tax, no mortgage → existingMortgage undefined, draw = 20% of home", () => {
  seedHome(testDb, 1_000_000);
  testDb.run("INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate) VALUES (1, 0.37, 0.238, 0.238)");
  testDb.run("INSERT INTO cashflow_settings (id, monthly_income, monthly_required_expense) VALUES (1, 15000, 9000)");
  const r = buildPrefill(testDb);
  if (!r.ok) throw new Error("expected prefill ok");
  expect(r.scenario.initialHomeValue).toBe(1_000_000);
  expect(r.scenario.existingMortgage).toBeUndefined();
  const loan = r.scenario.events.find((e) => e.kind === "take_loan")!;
  expect((loan.payload as any).principal).toBeCloseTo(200_000, 0);
});

test("prefill seeds ordinaryInvestmentIncomeMonthly from taxable brokerage balance at 1.5% annual", () => {
  seedHome(testDb, 1_000_000);
  testDb.run("INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate, ordinary_investment_income_monthly) VALUES (1, 0.37, 0.238, 0.238, 0)");
  testDb.run("INSERT INTO cashflow_settings (id, monthly_income, monthly_required_expense) VALUES (1, 15000, 9000)");
  testDb.run("INSERT INTO accounts (id, display_name, institution, type, mode) VALUES ('b1', 'Vanguard Taxable', 'Vanguard', 'brokerage', 'manual')");
  testDb.run("INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES ('b1', '2026-04-01', 400000, 'manual')");
  const r = buildPrefill(testDb);
  if (!r.ok) throw new Error("expected prefill ok");
  expect(r.scenario.tax.ordinaryInvestmentIncomeMonthly).toBeCloseTo(400_000 * 0.015 / 12, 1);
});

test("prefill preserves explicit ordinaryInvestmentIncomeMonthly and skips the estimator", () => {
  seedHome(testDb, 1_000_000);
  testDb.run("INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate, ordinary_investment_income_monthly) VALUES (1, 0.37, 0.238, 0.238, 1234)");
  testDb.run("INSERT INTO cashflow_settings (id, monthly_income, monthly_required_expense) VALUES (1, 15000, 9000)");
  testDb.run("INSERT INTO accounts (id, display_name, institution, type, mode) VALUES ('b1', 'Vanguard Taxable', 'Vanguard', 'brokerage', 'manual')");
  testDb.run("INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES ('b1', '2026-04-01', 400000, 'manual')");
  const r = buildPrefill(testDb);
  if (!r.ok) throw new Error("expected prefill ok");
  expect(r.scenario.tax.ordinaryInvestmentIncomeMonthly).toBe(1234);
});

test("mortgage detected via display_name match", () => {
  seedHome(testDb, 1_000_000);
  testDb.run("INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate) VALUES (1, 0.37, 0.238, 0.238)");
  testDb.run("INSERT INTO cashflow_settings (id, monthly_income, monthly_required_expense) VALUES (1, 15000, 9000)");
  testDb.run("INSERT INTO accounts (id, display_name, institution, type, mode) VALUES ('m1', 'Mortgage - Main', 'Northwind Bank', 'manual', 'manual')");
  testDb.run("INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES ('m1', '2026-04-01', -400000, 'manual')");
  testDb.run("INSERT INTO debt_terms (account_id, apr, min_payment_pct, min_payment_floor) VALUES ('m1', 0.03, 0.01, 0)");
  const r = buildPrefill(testDb);
  if (!r.ok) throw new Error("expected ok");
  expect(r.scenario.existingMortgage?.balance).toBe(400_000);
  expect(r.scenario.existingMortgage?.apr).toBe(0.03);
});

// ---------------------------------------------------------------------------
// Bond sleeve heuristic tests
// ---------------------------------------------------------------------------

function seedTaxableBrokerage(db: Database, id: string, name: string, balance: number) {
  db.prepare("INSERT INTO accounts (id, display_name, institution, type, mode) VALUES (?, ?, 'Vanguard', 'brokerage', 'manual')").run(id, name);
  db.prepare("INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES (?, '2026-04-01', ?, 'manual')").run(id, balance);
}

test("estimateBondSleeve: no bond accounts → undefined", () => {
  // Only an equity-named brokerage account — no bond signal
  seedTaxableBrokerage(testDb, "eq1", "Vanguard Total Stock Market", 100_000);
  const result = estimateBondSleeve(testDb);
  expect(result).toBeUndefined();
});

test("estimateBondSleeve: 40% in VGIT account → bond fraction ≈ 0.4, equity ≈ 0.6", () => {
  // $60k equity, $40k bond-named → bondFraction = 0.4 (>30% threshold)
  seedTaxableBrokerage(testDb, "eq1", "Vanguard Total Stock Market", 60_000);
  seedTaxableBrokerage(testDb, "bd1", "VGIT Treasury Bond Fund", 40_000);
  const result = estimateBondSleeve(testDb);
  expect(result).not.toBeUndefined();
  expect(result!.bond.fraction).toBeCloseTo(0.4, 5);
  expect(result!.equity.fraction).toBeCloseTo(0.6, 5);
  expect(result!.ordIncome.fraction).toBe(0);
});

test("estimateBondSleeve: below threshold (20% bond) → undefined", () => {
  // $80k equity, $20k bond-named → bondFraction = 0.2 (≤30% threshold → no sleeve)
  seedTaxableBrokerage(testDb, "eq1", "Vanguard Total Stock Market", 80_000);
  seedTaxableBrokerage(testDb, "bd1", "BND Bond Fund", 20_000);
  const result = estimateBondSleeve(testDb);
  expect(result).toBeUndefined();
});

test("buildPrefill: 40% bond holdings → scenario.composition set with bond sleeve", () => {
  seedHome(testDb, 1_000_000);
  testDb.run("INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate) VALUES (1, 0.37, 0.238, 0.238)");
  testDb.run("INSERT INTO cashflow_settings (id, monthly_income, monthly_required_expense) VALUES (1, 15000, 9000)");
  seedTaxableBrokerage(testDb, "eq1", "Vanguard Total Stock Market", 60_000);
  seedTaxableBrokerage(testDb, "bd1", "VGIT Treasury Bond Fund", 40_000);
  const r = buildPrefill(testDb);
  if (!r.ok) throw new Error("expected prefill ok");
  expect(r.scenario.composition).not.toBeUndefined();
  expect(r.scenario.composition!.bond.fraction).toBeCloseTo(0.4, 5);
  expect(r.scenario.composition!.equity.fraction).toBeCloseTo(0.6, 5);
});

test("buildPrefill: no bond holdings → scenario.composition undefined", () => {
  seedHome(testDb, 1_000_000);
  testDb.run("INSERT INTO tax_profile (id, marginal_ordinary_rate, ltcg_rate, qualified_div_rate) VALUES (1, 0.37, 0.238, 0.238)");
  testDb.run("INSERT INTO cashflow_settings (id, monthly_income, monthly_required_expense) VALUES (1, 15000, 9000)");
  seedTaxableBrokerage(testDb, "eq1", "Vanguard Total Stock Market", 100_000);
  const r = buildPrefill(testDb);
  if (!r.ok) throw new Error("expected prefill ok");
  expect(r.scenario.composition).toBeUndefined();
});

test("estimateBondSleeve: display_name_override takes precedence over display_name", () => {
  // display_name has no bond signal, but display_name_override does → should be detected
  testDb.run("INSERT INTO accounts (id, display_name, display_name_override, institution, type, mode) VALUES ('b1', 'Generic Account', 'VGIT Treasury Bond', 'Vanguard', 'brokerage', 'manual')");
  testDb.run("INSERT INTO balance_assertions (account_id, as_of, expected_usd, source) VALUES ('b1', '2026-04-01', 40000, 'manual')");
  seedTaxableBrokerage(testDb, "eq1", "Vanguard Total Stock Market", 60_000);
  const result = estimateBondSleeve(testDb);
  expect(result).not.toBeUndefined();
  expect(result!.bond.fraction).toBeCloseTo(0.4, 5);
  expect(result!.equity.fraction).toBeCloseTo(0.6, 5);
});
