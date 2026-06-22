#!/usr/bin/env bun
/**
 * Generate db/fixtures/affluent_household.yaml — a fully fictional
 * "balanced professional" household with ~$1.0M net worth, used as the
 * demo dataset for screenshots and local exploration.
 *
 * Deterministic (no RNG): re-running produces byte-identical YAML.
 *
 * Run: bun scripts/gen_demo_fixture.ts
 *
 * Data model (mirrors how the walker computes net worth):
 *   - Cash / home / mortgage / credit cards  -> monthly balance_assertions
 *     (postings-cumulative path with anchors, forward-filled to today).
 *   - Brokerage / 401(k) / Roth / crypto     -> positions + monthly
 *     position_snapshots (mark-to-market path; also feeds Investments).
 *   - ~3 weeks of categorized spending txns (May-Jun 2026) for the
 *     Spending screen, each balanced against equity:unknown-counterparty.
 *
 * Nothing here matches the owner's real institutions, account numbers,
 * or name — that is the entire point.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

// `yaml` is a dependency of @coffer/server, not the repo root — resolve it
// from the server workspace's node_modules.
const require = createRequire(resolve(import.meta.dir, "../apps/server/package.json"));
const { stringify } = require("yaml") as typeof import("yaml");

const AS_OF = "2026-06-15";
const HEADLINE = "2026-06-15"; // final anchor date pinning headline balances

// 13 monthly checkpoints: 2025-06-01 .. 2026-06-01
const MONTHS: string[] = [];
for (let m = 0; m < 13; m++) {
  const d = new Date(Date.UTC(2025, 5 + m, 1));
  MONTHS.push(d.toISOString().slice(0, 10));
}
const N = MONTHS.length; // 13

/** Linear trend start->end across the N monthly checkpoints, with an
 *  optional sinusoidal overlay so balances look organic instead of ruler-
 *  straight. `amp` is the wave height as a fraction of the (absolute) trend
 *  value; `cycles` is the number of full waves across the window.
 *
 *  cycles is kept a whole number on purpose: sin(2π·cycles·t) is exactly 0
 *  at t=0 and t=1, so both endpoints stay pinned to the trend — the start
 *  and the ~$1M headline stay clean and the trajectory stays upward, with
 *  the wobble living strictly in between. */
function ramp(start: number, end: number, amp = 0, cycles = 2): number[] {
  return MONTHS.map((_, i) => {
    const t = i / (N - 1);
    const trend = start + (end - start) * t;
    const wave = amp * Math.abs(trend) * Math.sin(2 * Math.PI * cycles * t);
    return Math.round((trend + wave) * 100) / 100;
  });
}

// ── Accounts ────────────────────────────────────────────────────────────────
const accounts = [
  { id: "northwind:chk-4021", type: "checking", institution: "Northwind Bank", display_name: "Everyday Checking (4021)", mode: "live", active: 1 },
  { id: "northwind:sav-7745", type: "savings", institution: "Northwind Bank", display_name: "High-Yield Savings (7745)", mode: "live", active: 1 },
  { id: "meridian:brk-1180", type: "brokerage", institution: "Meridian Securities", display_name: "Taxable Brokerage (1180)", mode: "live", active: 1 },
  { id: "keystone:401k-5560", type: "retirement", institution: "Keystone Retirement", display_name: "401(k) (5560)", mode: "live", active: 1 },
  { id: "meridian:roth-3309", type: "retirement", institution: "Meridian Securities", display_name: "Roth IRA (3309)", mode: "live", active: 1 },
  { id: "manual:home-primary", type: "manual", institution: "Real Estate", display_name: "Primary Residence", mode: "manual", active: 1 },
  { id: "self-custody:wallet-main", type: "crypto", institution: "Self-Custody", display_name: "Crypto Wallet", mode: "manual", active: 1 },
  { id: "granite:mortgage-8800", type: "manual", institution: "Granite Home Loans", display_name: "Mortgage (8800)", mode: "manual", active: 1 },
  { id: "vesta:cc-2014", type: "credit", institution: "Vesta Card", display_name: "Signature Rewards (2014)", mode: "live", active: 1 },
  { id: "northwind:cc-6677", type: "credit", institution: "Northwind Bank", display_name: "Everyday Rewards Card (6677)", mode: "live", active: 1 },
];

// ── Assertion-driven accounts (cash, home, mortgage, cards) ──────────────────
// source must exist in data_sources(kind='assertion'): simplefin, manual.
// The primary residence is a `manual`-type account (NOT one of the
// Investments INVESTMENT_TYPES = brokerage/retirement/crypto/alt), so it
// stays out of the Investments portfolio and the portfolio value equals the
// positions total. Home + mortgage group under the Overview "Manual" section.
const assertionSpecs: Array<{ id: string; source: string; series: number[] }> = [
  { id: "northwind:chk-4021", source: "simplefin", series: ramp(15800, 18200, 0.03, 3) },
  { id: "northwind:sav-7745", source: "simplefin", series: ramp(49000, 62000, 0.02, 2) },
  { id: "manual:home-primary", source: "manual", series: ramp(510000, 520000) }, // real estate: smooth
  { id: "granite:mortgage-8800", source: "manual", series: ramp(-279000, -270000) }, // amortizes smoothly
  { id: "vesta:cc-2014", source: "simplefin", series: ramp(-3100, -2840, 0.08, 4) },
  { id: "northwind:cc-6677", source: "simplefin", series: ramp(-820, -1080, 0.1, 3) },
];

const balance_assertions: Array<Record<string, unknown>> = [];
for (const spec of assertionSpecs) {
  MONTHS.forEach((as_of, i) => {
    balance_assertions.push({
      account_id: spec.id,
      as_of,
      expected_usd: spec.series[i],
      source: spec.source,
      source_file: "feed",
    });
  });
  // Headline anchor pins the as-of-today balance regardless of any
  // spending postings recorded after the last monthly checkpoint.
  balance_assertions.push({
    account_id: spec.id,
    as_of: HEADLINE,
    expected_usd: spec.series[N - 1],
    source: spec.source,
    source_file: "feed",
  });
}

// ── Position-driven accounts (brokerage, 401k, roth, crypto) ─────────────────
// Each holding: nominal price (cosmetic; no asset_prices rows are emitted, so
// INV-8 qty*price check is skipped) used only to derive a believable quantity.
interface Holding {
  account_id: string;
  symbol: string;
  asset_class: string;
  chain: string;
  contract: string;
  price: number;
  series: number[]; // value_usd per month
  source: string;
  qtyNull?: boolean; // real estate: no share quantity
  costBasis?: number; // override (default = first-month value)
}

const holdings: Holding[] = [
  // Taxable brokerage: 242k -> 286k. Equities share a 2-cycle market rhythm.
  { account_id: "meridian:brk-1180", symbol: "VTI", asset_class: "equity", chain: "", contract: "", price: 275, source: "simplefin", series: ramp(133000, 157000, 0.04, 2) },
  { account_id: "meridian:brk-1180", symbol: "VXUS", asset_class: "equity", chain: "", contract: "", price: 62, source: "simplefin", series: ramp(61000, 72000, 0.045, 2) },
  { account_id: "meridian:brk-1180", symbol: "AAPL", asset_class: "equity", chain: "", contract: "", price: 212, source: "simplefin", series: ramp(48000, 57000, 0.06, 2) },
  // 401(k): 201k -> 235k
  { account_id: "keystone:401k-5560", symbol: "TDF2045", asset_class: "equity", chain: "", contract: "", price: 26, source: "simplefin", series: ramp(201000, 235000, 0.03, 2) },
  // Roth IRA: 109k -> 130k
  { account_id: "meridian:roth-3309", symbol: "VTI", asset_class: "equity", chain: "", contract: "", price: 275, source: "simplefin", series: ramp(109000, 130000, 0.04, 2) },
  // Crypto: 21k -> 30k. Higher amplitude, its own 3-cycle rhythm.
  { account_id: "self-custody:wallet-main", symbol: "BTC", asset_class: "crypto", chain: "bitcoin", contract: "", price: 64000, source: "zerion", series: ramp(13500, 19500, 0.12, 3) },
  { account_id: "self-custody:wallet-main", symbol: "ETH", asset_class: "crypto", chain: "ethereum", contract: "", price: 3400, source: "zerion", series: ramp(7500, 10500, 0.14, 3) },
];

const positions: Array<Record<string, unknown>> = [];
const position_snapshots: Array<Record<string, unknown>> = [];
holdings.forEach((h, idx) => {
  const positionId = idx + 1; // 1-based, matches insertion order on a fresh DB
  positions.push({
    account_id: h.account_id,
    chain: h.chain,
    contract_address: h.contract,
    symbol: h.symbol,
    asset_class: h.asset_class,
  });
  // cost_basis ~ first-month value (or override), held flat so Investments
  // shows gains.
  const costBasis = h.costBasis ?? h.series[0];
  MONTHS.forEach((as_of, i) => {
    const value = h.series[i];
    position_snapshots.push({
      position_id: positionId,
      as_of,
      source: h.source,
      quantity: h.qtyNull ? null : Math.round((value / h.price) * 10000) / 10000,
      value_usd: value,
      cost_basis: costBasis,
    });
  });
});

// ── Categorized spending (May-Jun 2026) for the Spending screen ──────────────
const CHK = "northwind:chk-4021";
const VESTA = "vesta:cc-2014";
const NWCC = "northwind:cc-6677";
const COUNTER = "equity:unknown-counterparty";

const spend: Array<{ date: string; desc: string; acct: string; amt: number; cat: string }> = [
  // ── May 2026 (feeds 30/90-day + 12-month views) ──
  { date: "2026-05-03", desc: "Riverside Power & Light", acct: CHK, amt: 162.40, cat: "Utilities" },
  { date: "2026-05-05", desc: "Summit Fuel", acct: VESTA, amt: 71.30, cat: "Gas" },
  { date: "2026-05-07", desc: "Bella Vista Trattoria", acct: VESTA, amt: 94.60, cat: "Restaurants" },
  { date: "2026-05-10", desc: "Greenfield Market", acct: CHK, amt: 156.78, cat: "Groceries" },
  { date: "2026-05-12", desc: "Apex Fitness Club", acct: VESTA, amt: 59.00, cat: "Fitness" },
  { date: "2026-05-15", desc: "Northgate Apparel", acct: VESTA, amt: 128.95, cat: "Shopping" },
  { date: "2026-05-19", desc: "Greenfield Market", acct: CHK, amt: 142.64, cat: "Groceries" },
  { date: "2026-05-23", desc: "Summit Fuel", acct: VESTA, amt: 66.10, cat: "Gas" },
  { date: "2026-05-28", desc: "Bella Vista Trattoria", acct: VESTA, amt: 72.40, cat: "Restaurants" },
  // ── June 2026 (current month — the default Spending tab) ──
  { date: "2026-06-01", desc: "Warehouse Club", acct: CHK, amt: 268.72, cat: "Groceries" },
  { date: "2026-06-01", desc: "Riverside Power & Light", acct: CHK, amt: 151.80, cat: "Utilities" },
  { date: "2026-06-02", desc: "Lakeview Roasters", acct: VESTA, amt: 11.25, cat: "Coffee" },
  { date: "2026-06-02", desc: "Streamline Internet", acct: CHK, amt: 84.99, cat: "Internet" },
  { date: "2026-06-03", desc: "Summit Fuel", acct: VESTA, amt: 68.40, cat: "Gas" },
  { date: "2026-06-04", desc: "Harbor Sushi", acct: VESTA, amt: 91.20, cat: "Restaurants" },
  { date: "2026-06-05", desc: "Greenfield Market", acct: CHK, amt: 173.55, cat: "Groceries" },
  { date: "2026-06-05", desc: "Soundwave Music", acct: NWCC, amt: 10.99, cat: "Entertainment" },
  { date: "2026-06-06", desc: "Cornerstone Pharmacy", acct: CHK, amt: 52.30, cat: "Healthcare" },
  { date: "2026-06-07", desc: "Bella Vista Trattoria", acct: VESTA, amt: 78.85, cat: "Restaurants" },
  { date: "2026-06-08", desc: "Lakeview Roasters", acct: VESTA, amt: 9.50, cat: "Coffee" },
  { date: "2026-06-08", desc: "Cloudline Software", acct: NWCC, amt: 54.99, cat: "Software" },
  { date: "2026-06-09", desc: "Apex Fitness Club", acct: VESTA, amt: 59.00, cat: "Fitness" },
  { date: "2026-06-10", desc: "Northgate Apparel", acct: VESTA, amt: 142.30, cat: "Shopping" },
  { date: "2026-06-11", desc: "Vista Cinema", acct: NWCC, amt: 44.00, cat: "Entertainment" },
  { date: "2026-06-12", desc: "Greenfield Market", acct: CHK, amt: 158.90, cat: "Groceries" },
  { date: "2026-06-12", desc: "Summit Fuel", acct: VESTA, amt: 64.75, cat: "Gas" },
  { date: "2026-06-13", desc: "Brookside Diner", acct: VESTA, amt: 53.40, cat: "Restaurants" },
  { date: "2026-06-14", desc: "Lakeview Roasters", acct: VESTA, amt: 10.75, cat: "Coffee" },
  { date: "2026-06-14", desc: "City Water Utility", acct: CHK, amt: 58.20, cat: "Utilities" },
];

// Semi-monthly net paychecks across the last 90 days so cashflow detects
// income (~$9k/mo). Positive postings to checking with a payroll payee.
const PAYROLL = "Atlas Industries Payroll";
const income: Array<{ date: string; amt: number }> = [
  { date: "2026-03-31", amt: 4520.0 },
  { date: "2026-04-15", amt: 4520.0 },
  { date: "2026-04-30", amt: 4520.0 },
  { date: "2026-05-15", amt: 4520.0 },
  { date: "2026-05-29", amt: 4520.0 },
  { date: "2026-06-15", amt: 4520.0 },
];

const postings: Array<Record<string, unknown>> = [
  ...spend.map((s) => ({
    txn: { date: s.date, description: s.desc, derived_by: "ingest" },
    legs: [
      { account_id: s.acct, amount: -s.amt },
      { account_id: COUNTER, amount: s.amt },
    ],
    items: [{ line_no: 1, name: s.desc, line_total: -s.amt, category: s.cat }],
  })),
  ...income.map((p) => ({
    txn: { date: p.date, description: PAYROLL, derived_by: "ingest" },
    legs: [
      { account_id: CHK, amount: p.amt, payee: PAYROLL },
      { account_id: "equity:opening-balance", amount: -p.amt },
    ],
  })),
];

// ── Emit ─────────────────────────────────────────────────────────────────────
const doc = {
  name: "affluent_household",
  description:
    "Fully fictional 'balanced professional' household (~$1.0M net worth): " +
    "checking + high-yield savings, taxable brokerage, 401(k) and Roth IRA, " +
    "a primary residence with a mortgage, two credit cards, and a self-custody " +
    "crypto wallet. Monthly history Jun 2025 - Jun 2026. No real institutions, " +
    "account numbers, or names. Demo/screenshot dataset.",
  as_of: AS_OF,
  accounts,
  balance_assertions,
  positions,
  position_snapshots,
  postings,
};

const outPath = resolve(import.meta.dir, "../db/fixtures/affluent_household.yaml");
const header =
  "# GENERATED by scripts/gen_demo_fixture.ts — do not edit by hand.\n" +
  "# Regenerate: bun scripts/gen_demo_fixture.ts\n";
writeFileSync(outPath, header + stringify(doc, { lineWidth: 0 }));
console.log(`wrote ${outPath}`);
console.log(
  `accounts=${accounts.length} assertions=${balance_assertions.length} ` +
    `positions=${positions.length} snapshots=${position_snapshots.length} ` +
    `postings=${postings.length}`,
);
