// DTOs shared between the Hono API and the Vite/React web app.
// Both sides import from this file via relative path — keep it dependency-free.

export type AccountType =
  | "credit"
  | "checking"
  | "savings"
  | "brokerage"
  | "retirement"
  | "crypto"
  | "alt"
  | "manual";

/** Display ordering for account-type sections in UI lists. */
export const ACCOUNT_TYPE_ORDER: AccountType[] = [
  "checking",
  "savings",
  "brokerage",
  "retirement",
  "alt",
  "crypto",
  "manual",
  "credit",
];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  brokerage: "Brokerage",
  retirement: "Retirement",
  alt: "Alternative",
  crypto: "Crypto",
  manual: "Manual",
  credit: "Credit cards",
};

export type BalanceSource =
  | "simplefin"
  | "kubera"
  | "manual"
  | "postings-v2"
  | "positions-mark-to-market"
  | "unified-walk"
  | null;

export type AccountMode = "live" | "manual";

export interface Account {
  id: string;
  display_name: string;
  /** User-set or Kubera-derived nickname; takes precedence over display_name when set. */
  display_name_override: string | null;
  institution: string;
  type: AccountType;
  currency: string;
  active: number; // 0 | 1
  /** Sync mode: 'live' (continuously synced) vs 'manual' (snapshot/placeholder). */
  mode: AccountMode;
  /** Latest balance in USD, or null if no balance recorded. */
  latest_balance: number | null;
  /** ISO date of the latest balance snapshot, or null. */
  latest_as_of: string | null;
  /** Where the latest balance came from — drives the LIVE vs SNAPSHOT badge. */
  latest_source: BalanceSource;
  /** Optional list of holdings (positions) within this account. */
  holdings?: Holding[];
}

export interface Holding {
  symbol: string;
  asset_class: string | null;
  quantity: number | null;
  value_usd: number;
  /** ISO date of the snapshot. */
  as_of: string;
}

export interface TransactionRow {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  description: string;
  merchant: string | null;
  subcategory: string | null;
  /** Comma-separated tags from the categorize pipeline. May be null. */
  tags: string | null;
  /** Cleaned merchant name from the source feed (e.g. SimpleFIN payee). */
  payee: string | null;
  /** Optional source-provided memo (e.g. Venmo note). */
  memo: string | null;
  /** Best-effort city/state hint extracted from description at ingest. */
  location_hint: string | null;
  /** Bundle id if this transaction belongs to one (trip, renovation, etc). */
  bundle_id: string | null;
  /** When true, this transaction is excluded from the Spending page's
   *  donut, category totals, and default transaction list. The Spending
   *  page exposes a right-click toggle to flip this. Cashflow detector
   *  and balance walks intentionally ignore this flag.
   *
   *  Absent (vs. `false`) means the field was not emitted by the caller's
   *  endpoint. Only the spending routes populate it; readers from other
   *  endpoints should not interpret absence as "included." */
  excluded_from_spending?: boolean;
  /** Receipt metadata when an email has been matched to this transaction. */
  receipt?: TransactionReceipt | null;
  /** Line items extracted from the matched receipt (if any). */
  items?: TransactionItem[];
}

export interface SpendingTransactionsResponse {
  rows: TransactionRow[];
  /** Count of excluded rows in the requested (category, from, to) window.
   *  Drives the "Show N ignored" pill on the Spending page. */
  excluded_count: number;
}

export interface TransactionReceipt {
  email_id: string;
  merchant: string | null;
  order_id: string | null;
  /** strict | fuzzy | uncertain — source of confidence. */
  match_status: "strict" | "fuzzy" | "uncertain";
}

export interface TransactionItem {
  id: number;
  name: string;
  /** LLM-shortened 2-5 word description; null if not yet shortened. */
  short_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  /** Keyword-rule category (grocery, electronics, clothing, ...) or null. */
  category: string | null;
  /** Optional finer-grained label within the category. */
  subcategory: string | null;
}

export type BundleType = "trip" | "renovation" | "project";

export interface CategoryOption {
  category: string;
  subcategories: string[];
}

export type CategoryHierarchy = CategoryOption[];

export interface Bundle {
  id: string;
  slug: string;
  name: string;
  type: BundleType;
  start_date: string;
  end_date: string;
  total_usd: number;
  txn_count: number;
  category_options: CategoryOption[];
}

export interface BundleDetail extends Bundle {
  transactions: TransactionRow[];
}

export interface NetWorthPoint {
  date: string;
  net_worth: number;
  total_assets: number;
  total_debts: number;
}

export interface AccountTransactionsGroup {
  account: Account;
  count: number;
  sum: number;
  earliest: string | null;
  latest: string | null;
  transactions: TransactionRow[];
}

export interface CategoryBreakdownRow {
  category: string;
  count: number;
  total: number;
  /** Top merchants for this category, ordered by absolute spend */
  top_merchants: { description: string; total: number; count: number }[];
}

export interface SpendingBreakdown {
  from: string | null;
  to: string | null;
  total_spend: number; // negative number (sum of expense)
  rows: CategoryBreakdownRow[];
}

export interface SubcategoryRow {
  /** null = items with no subcategory yet */
  category: string | null;
  count: number;
  /** Positive dollar total for items in this subcategory */
  total: number;
}

export interface ItemsByCategory {
  parent: string;
  total_items: number;
  /**
   * Count of items that have a subcategory assigned. Note: this counts items
   * with a non-null subcategory, not items with a non-null category — within
   * the items-by-category drill-down, every item already has a category.
   */
  classified: number;
  unclassified: number;
  subcategories: SubcategoryRow[];
}

export interface Summary {
  net_worth: number;
  total_assets: number;
  total_debts: number;
  as_of: string | null; // ISO date of the latest snapshot used
  counts: {
    accounts: number;
    active_accounts: number;
  };
}

// ---------------------------------------------------------------------------
// Debt
// ---------------------------------------------------------------------------

export interface DebtAccount {
  account_id: string;
  display_name: string;
  /** Positive number — the amount owed. */
  balance: number;
  apr: number | null;
  min_payment_pct: number | null;
  min_payment_floor: number | null;
  promo_balance: number | null;
  promo_apr: number | null;
  promo_expires_at: string | null;
  notes: string | null;
}

export interface DebtSummary {
  accounts: DebtAccount[];
  total_debt: number;
  monthly_minimums: number;
  weighted_avg_apr: number;
}

export interface DebtPlanAccount {
  account_id: string;
  display_name: string;
  starting_balance: number;
  paid_off_month: number | null;
  total_interest: number;
  series: { month: number; balance: number }[];
}

export interface DebtPlanResponse {
  months_to_zero: number;
  total_interest: number;
  accounts: DebtPlanAccount[];
}

// ---------------------------------------------------------------------------
// Cashflow
// ---------------------------------------------------------------------------

export interface CashflowResponse {
  detected_monthly_income: number;
  detected_monthly_required: number;
  user_monthly_income: number | null;
  user_monthly_required: number | null;
  pay_frequency: string;
  monthly_minimums: number;
  effective_income: number;
  effective_required: number;
  available_for_debt: number;
  required_breakdown: { category: string; monthly_avg: number }[];
  income_breakdown: { source: string; monthly_avg: number; count: number }[];
  notes: string | null;
}

export type Granularity = "day" | "week" | "month" | "year";

export type DebtStrategy = "avalanche" | "snowball" | "even";

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

export interface InvestmentSeriesPoint {
  date: string;
  portfolio_value: number;
  total_invested: number;
  total_return: number;
  return_pct: number | null;
}

export interface InvestmentsSeriesResponse {
  series: InvestmentSeriesPoint[];
}

export interface TradeRow {
  date: string;
  type: string;
  sent_currency: string;
  sent_qty: number;
  sent_basis: number;
  recv_currency: string;
  recv_qty: number;
  recv_basis: number;
  realized_pnl: number;
  wallet: string;
  /** Canonical (alias-folded) tickers for matching trades to a holding row. Empty for manual-loss rows. */
  canonical_sent: string;
  canonical_recv: string;
}

export interface RealizedSeriesPoint {
  date: string;
  /** Inclusive calendar span of the bucket this point represents. For
   *  day-granularity both equal `date`; for month-granularity they span
   *  the full calendar month regardless of which days inside it had
   *  events. Drag-selection callbacks report these so downstream
   *  `date >= bucket_start AND date <= bucket_end` filters pick up
   *  exactly the events the chart summed into the bucket. */
  bucket_start: string;
  bucket_end: string;
  realized: number;
  cumulative: number;
}

export interface InvestmentsRealizedSeriesResponse {
  series: RealizedSeriesPoint[];
}

export interface HoldingRow {
  symbol: string;
  type: "crypto" | "brokerage";
  account_name: string | null;
  value_usd: number;
  quantity: number;
  cost_basis: number | null;
  /** [0,1] when basis covers only a partial share of live qty; null when full coverage or no basis. */
  basis_coverage: number | null;
  /** Which pipeline produced the basis value — drives UI badges + edit affordance. */
  basis_source: "simplefin" | "cointracker-fifo" | "stablecoin" | "manual" | null;
  unrealized_pnl: number | null;
  /** Lifetime realized P&L on this canonical symbol (crypto only). */
  realized_pnl: number | null;
  /** True for rows with realized history but no current holding. */
  closed: boolean;
}

export interface InvestmentsHoldingsTotals {
  value: number;
  cost_basis: number;
  unrealized_pnl: number;
  realized_pnl: number;
  /** Manual realized losses not tied to any specific symbol. Included in realized_pnl above. */
  manual_adjustments: number;
}

export interface InvestmentsHoldingsResponse {
  holdings: HoldingRow[];
  totals: InvestmentsHoldingsTotals;
}

export interface InvestmentFlowRow {
  date: string;
  amount: number;
  direction: "in" | "out";
  account_id: string;
  account_name: string;
  account_type: string;
  counterparty_name: string;
  description: string;
}

export interface BasisOverride {
  id: number;
  symbol: string;
  account_id: string | null;
  cost_usd: number;
  quantity_at_entry: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Shared snapshot / history shape (accounts, wallets, bundles, networth breakdown)
// ---------------------------------------------------------------------------

/** One date-bucketed snapshot with a total and per-symbol breakdown. */
export interface HoldingsSnapshot {
  as_of: string;
  total: number;
  holdings: { symbol: string; value_usd: number }[];
}

export interface HoldingsHistoryResponse {
  snapshots: HoldingsSnapshot[];
}

// ---------------------------------------------------------------------------
// Wallet composition (per-chain DeFi view)
// ---------------------------------------------------------------------------

export interface WalletPosition {
  symbol: string;
  chain: string;
  contract_address: string;
  quantity: number;
  value_usd: number;
  as_of: string;
}

export interface WalletChainComposition {
  account_id: string;
  chain: string;
  zerion_total: number;
  zerion_anchor_date: string | null;
  alchemy_sum: number;
  residual: number;
  flag: "alchemy_exceeds_zerion" | null;
  positions: WalletPosition[];
}

export interface WalletCompositionResponse {
  address: string;
  date: string;
  per_chain: WalletChainComposition[];
  totals: {
    zerion_total: number;
    alchemy_sum: number;
    residual: number;
  };
}

/**
 * Streaming sync events. Emitted by the Python pipeline via fd 3 and
 * forwarded over SSE to the web client. Every event is tagged with the
 * server-stamped `ts` (ISO 8601) and a monotonic per-run `seq`.
 */
export type SyncEventBase = {
  ts: string;
  seq: number;
  run_id: string;
};

export type SyncStartedEvent = SyncEventBase & {
  type: "sync_started";
  sources: string[];
};

export type SyncFinishedEvent = SyncEventBase & {
  type: "sync_finished";
  ok: boolean;
  totals: Record<string, unknown>;
};

export type AccountStartedEvent = SyncEventBase & {
  type: "account_started";
  account_id: string;
  source: string;
};

export type AccountFinishedEvent = SyncEventBase & {
  type: "account_finished";
  account_id: string;
  ok: boolean;
};

export type AccountLogEvent = SyncEventBase & {
  type: "account_log";
  account_id: string;
  message: string;
  level: "info" | "warn" | "error";
};

export type SyncWarningEvent = SyncEventBase & {
  type: "warning";
  account_id: string | null;
  message: string;
};

export type SyncEvent =
  | SyncStartedEvent
  | SyncFinishedEvent
  | AccountStartedEvent
  | AccountFinishedEvent
  | AccountLogEvent
  | SyncWarningEvent;

/** Snapshot returned by GET /api/sync/runs for hard-refresh clients. */
export type SyncRunSummary = {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  events: SyncEvent[];
};

export type SyncRunSnapshot = {
  current: SyncRunSummary | null;
  history: SyncRunSummary[];
};

/** Trigger endpoint response. POST /api/sync/{all,simplefin,zerion}. */
export type SyncTriggerResponse = { run_id: string };

// ============================================================================
// Projections sandbox (spec: docs/superpowers/specs/2026-04-17-heloc-invest-sandbox-design.md)
// ============================================================================

export type RateType = "fixed" | "variable";

export type TakeLoanPayload = {
  loan_id: string;
  principal: number;
  apr: number;
  term_months: number;
  rate_type: RateType;
  closing_costs: number;
  min_payment_pct?: number;
  interest_only_months?: number;
  traced_to_investment: boolean;
};

export type InvestCashPayload = {
  amount: number;
  into: "baseline" | "cash_reserve";
  funded_by_loan_id?: string;
};

export type LoanPaymentSchedulePayload = {
  loan_id: string;
  from: "earned_income" | "portfolio";
  monthly_extra?: number;
};

export type RateResetPayload = { loan_id: string; new_apr: number };

export type MarketShockPayload = {
  equity_drawdown_pct: number;
  home_drawdown_pct: number;
  duration_months: number;
};

export type LiquidatePayload = {
  amount_or_pct: { kind: "amount"; value: number } | { kind: "pct"; value: number };
  to: "payoff_loan" | "cash";
};

export type CashflowOverridePayload = {
  monthly_income?: number;
  monthly_expense?: number;
};

export type ScenarioEvent =
  | { kind: "take_loan"; atMonth: number; payload: TakeLoanPayload }
  | { kind: "invest_cash"; atMonth: number; payload: InvestCashPayload }
  | { kind: "loan_payment_schedule"; atMonth: number; payload: LoanPaymentSchedulePayload }
  | { kind: "rate_reset"; atMonth: number; payload: RateResetPayload }
  | { kind: "market_shock"; atMonth: number; payload: MarketShockPayload }
  | { kind: "liquidate"; atMonth: number; payload: LiquidatePayload }
  | { kind: "cashflow_override"; atMonth: number; payload: CashflowOverridePayload };

export type TaxProfile = {
  marginalOrdinaryRate: number;
  ltcgRate: number;
  qualifiedDivRate: number;
  ltcgElection: boolean;
  ordinaryInvestmentIncomeMonthly: number;
};

export type SleeveParams = {
  fraction: number;      // 0..1, fractions across all sleeves sum to 1
  expectedReturn: number; // annualized total return
  volPct: number;         // annualized vol
  ordinaryYield: number;  // annualized rate on sleeve balance, taxed as ordinary income (bond coupons, REIT ord div, MMF interest)
  qualifiedYield: number; // annualized rate on sleeve balance, taxed at qualified-div rate
  // capital-appreciation rate = expectedReturn - ordinaryYield - qualifiedYield (taxed as LTCG on realization)
};

export type PortfolioComposition = {
  equity: SleeveParams;
  bond: SleeveParams;
  ordIncome: SleeveParams; // e.g., T-bills, MMFs, REITs held for ord div
};

export const DEFAULT_COMPOSITION: PortfolioComposition = {
  equity:    { fraction: 1.0, expectedReturn: 0.065, volPct: 0.15, ordinaryYield: 0.00, qualifiedYield: 0.02 },
  bond:      { fraction: 0.0, expectedReturn: 0.045, volPct: 0.05, ordinaryYield: 0.045, qualifiedYield: 0.00 },
  ordIncome: { fraction: 0.0, expectedReturn: 0.050, volPct: 0.01, ordinaryYield: 0.050, qualifiedYield: 0.00 },
};

export type FilingStatus = "single" | "mfj" | "hoh";

export type TaxSuggestResponse = {
  filingStatus: FilingStatus;
  annualIncome: number;
  marginalOrdinaryRate: number;
  ltcgRate: number;
  qualifiedDivRate: number;
  niitApplies: boolean;
};

export type Scenario = {
  id?: string;
  name?: string;
  notes?: string;
  /** Which projection page this scenario belongs to. Defaults to "heloc"
   *  for legacy scenarios (backfilled by migration 054). */
  projectionKind?: "heloc" | "retirement" | "mortgage";
  startDate: string;
  horizonMonths: number;
  baselineReturnPct: number;
  baselineVolPct: number;
  homeAppreciationPct: number;
  mc: { enabled: boolean; paths: number; seed?: number };
  events: ScenarioEvent[];
  initialHomeValue: number;
  initialPortfolioValue: number;
  existingMortgage?: { balance: number; apr: number; monthlyPayment: number };
  monthlyIncome: number;
  monthlyExpense: number;
  tax: TaxProfile;
  composition?: PortfolioComposition;
};

export type TimelineRow = {
  month: number;
  netWorth: number;
  homeEquity: number;
  portfolioValue: number;
  loanBalance: number;
  cumulativeInterestPaid: number;
  cumulativeTaxSaved: number;
  underwaterOnHome: boolean;
  netWorseOffVsBaseline: boolean;
  forcedLiquidation: boolean;
  sleeves?: { equity: number; bond: number; ordIncome: number };
};

export type Warning = {
  kind:
    | "composition_fractions_normalized"
    | "draw_exceeds_equity"
    | "forced_liquidation"
    | "inconsistent_tracing"
    | "mc_extreme_tail"
    | "mortgage_exceeds_home"
    | "no_breakeven_in_range"
    | string;
  message: string;
  month?: number;
};

export type Timeline = {
  months: TimelineRow[];
  mc?: { p10: number[]; p25: number[]; p50: number[]; p75: number[]; p90: number[] };
  warnings: Warning[];
};

export type ProjectionSummary = {
  finalNetWorth: number;
  finalNetWorthAfterTaxIfLiquidated: number;
  deltaVsBaseline: number;
  breakEvenReturnPct: number | null;
  firstMonthUnderwaterOnHome?: number;
  mcSuccessProbability?: number;
};

export type ProjectionRunResponse = {
  timeline: Timeline;
  comparison?: Timeline;
  summary: ProjectionSummary;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type AdvisorChatRequest = {
  messages: ChatMessage[];
  scenario: Scenario;
  runResult: ProjectionRunResponse;
};

export type PrefillResponse =
  | { ok: true; scenario: Scenario; tax: TaxProfile }
  | { ok: false; requiresHome?: true; requiresTaxProfile?: true; message: string };

// ---------------------------------------------------------------------------
// Sinking-fund goals
// ---------------------------------------------------------------------------

export interface Goal {
  id: number;
  name: string;
  target_amount: number;
  allocated_amount: number;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
  pct_funded: number;
  /** Allocation per month needed to reach target_amount by due_date. Omitted when due_date is null or the goal is already funded. */
  monthly_pace?: number;
  is_funded: boolean;
}

export interface GoalsListResponse {
  goals: Goal[];
}
