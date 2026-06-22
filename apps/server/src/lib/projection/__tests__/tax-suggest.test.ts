import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { suggestTaxProfile } from "../tax-suggest";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    `CREATE TABLE cashflow_settings (id INTEGER PRIMARY KEY CHECK (id = 1), monthly_income REAL, monthly_required_expense REAL, pay_frequency TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
  );
});

afterEach(() => { db.close(); });

function setIncome(monthly: number) {
  db.run("INSERT INTO cashflow_settings (id, monthly_income) VALUES (1, ?)", [monthly]);
}

test("single filer at $129,720 lands in 24% bracket, 15% LTCG, no NIIT", () => {
  setIncome(10_810);
  const r = suggestTaxProfile(db, { filingStatus: "single" });
  expect(r.annualIncome).toBeCloseTo(129_720, 0);
  expect(r.marginalOrdinaryRate).toBe(0.24);
  expect(r.ltcgRate).toBe(0.15);
  expect(r.qualifiedDivRate).toBe(0.15);
  expect(r.niitApplies).toBe(false);
});

test("single filer above NIIT threshold adds 3.8%", () => {
  setIncome(25_000); // $300k annual
  const r = suggestTaxProfile(db, { filingStatus: "single" });
  expect(r.niitApplies).toBe(true);
  expect(r.ltcgRate).toBeCloseTo(0.188, 4); // 15% + 3.8%
});

test("top-bracket single filer gets 37% ordinary, 23.8% LTCG", () => {
  setIncome(100_000); // $1.2M annual
  const r = suggestTaxProfile(db, { filingStatus: "single" });
  expect(r.marginalOrdinaryRate).toBe(0.37);
  expect(r.ltcgRate).toBeCloseTo(0.238, 4); // 20% + 3.8%
});

test("MFJ at $200k lands below NIIT threshold", () => {
  setIncome(16_667); // ~$200k annual
  const r = suggestTaxProfile(db, { filingStatus: "mfj" });
  expect(r.marginalOrdinaryRate).toBe(0.22);
  expect(r.niitApplies).toBe(false);
});

test("MFJ at $260k triggers NIIT", () => {
  setIncome(21_667); // ~$260k annual
  const r = suggestTaxProfile(db, { filingStatus: "mfj" });
  expect(r.niitApplies).toBe(true);
});

test("low-income single filer in 0% LTCG bracket", () => {
  setIncome(3_000); // $36k annual
  const r = suggestTaxProfile(db, { filingStatus: "single" });
  expect(r.marginalOrdinaryRate).toBe(0.12);
  expect(r.ltcgRate).toBe(0.0);
});

test("no cashflow row → annualIncome 0, lowest brackets", () => {
  const r = suggestTaxProfile(db, { filingStatus: "single" });
  expect(r.annualIncome).toBe(0);
  expect(r.marginalOrdinaryRate).toBe(0.10);
  expect(r.ltcgRate).toBe(0.0);
});

test("explicit annualIncome overrides cashflow_settings lookup", () => {
  setIncome(10_810); // would be $129,720 annual
  const r = suggestTaxProfile(db, { filingStatus: "single", annualIncome: 500_000 });
  expect(r.annualIncome).toBe(500_000);
  expect(r.marginalOrdinaryRate).toBe(0.35);
  expect(r.niitApplies).toBe(true);
  expect(r.ltcgRate).toBeCloseTo(0.188, 4);
});

test("HoH brackets differ from single at mid income", () => {
  setIncome(5_000); // $60k annual
  const single = suggestTaxProfile(db, { filingStatus: "single" });
  const hoh = suggestTaxProfile(db, { filingStatus: "hoh" });
  expect(single.marginalOrdinaryRate).toBe(0.22);
  expect(hoh.marginalOrdinaryRate).toBe(0.12);
});
