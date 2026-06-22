import type {
  Account,
  AccountTransactionsGroup,
  BasisOverride,
  Bundle,
  BundleDetail,
  BundleType,
  CashflowResponse,
  CategoryHierarchy,
  CategoryOption,
  DebtAccount,
  DebtPlanResponse,
  DebtStrategy,
  DebtSummary,
  Goal,
  GoalsListResponse,
  Holding,
  HoldingRow,
  HoldingsHistoryResponse,
  HoldingsSnapshot,
  InvestmentFlowRow,
  InvestmentsHoldingsResponse,
  InvestmentsRealizedSeriesResponse,
  InvestmentsSeriesResponse,
  ItemsByCategory,
  NetWorthPoint,
  SpendingBreakdown,
  SpendingTransactionsResponse,
  SubcategoryRow,
  Summary,
  SyncTriggerResponse,
  TradeRow,
  TransactionItem,
  TransactionRow,
  WalletCompositionResponse,
} from "../../../../packages/shared/types";

export type {
  Account,
  AccountTransactionsGroup,
  BasisOverride,
  Bundle,
  BundleDetail,
  BundleType,
  CashflowResponse,
  CategoryHierarchy,
  CategoryOption,
  DebtAccount,
  DebtPlanResponse,
  DebtSummary,
  Goal,
  GoalsListResponse,
  Holding,
  HoldingRow,
  HoldingsHistoryResponse,
  HoldingsSnapshot,
  InvestmentFlowRow,
  InvestmentsHoldingsResponse,
  InvestmentsRealizedSeriesResponse,
  InvestmentsSeriesResponse,
  ItemsByCategory,
  NetWorthPoint,
  SpendingBreakdown,
  SpendingTransactionsResponse,
  SubcategoryRow,
  Summary,
  SyncTriggerResponse,
  TradeRow,
  TransactionItem,
  TransactionRow,
  WalletCompositionResponse,
};

export interface ProviderConnection {
  id: string;
  label: string;
  needsAuth: boolean;
  enabled: boolean;
  status: string;
  connected: boolean;
  last_connected_at: string | null;
  config: Record<string, unknown>;
  configuredSecrets: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${path}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  connections: () => get<ProviderConnection[]>("/api/connections"),
  connectProvider: async (id: string, fields: Record<string, string>) => {
    const res = await fetch(`/api/connections/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(msg.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  disconnectProvider: async (id: string) => {
    const res = await fetch(`/api/connections/${encodeURIComponent(id)}/disconnect`, { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  setProviderEnabled: async (id: string, enabled: boolean) => {
    const res = await fetch(`/api/connections/${encodeURIComponent(id)}/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enabled ? 1 : 0 }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  syncProvider: async (id: string) => {
    // Reuses the existing per-provider sync routes (/api/sync/<id>).
    const res = await fetch(`/api/sync/${encodeURIComponent(id)}`, { method: "POST" });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(msg.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  accounts: () => get<Account[]>("/api/accounts"),
  summary: () => get<Summary>("/api/summary"),
  transactionsByAccount: (limit = 20) =>
    get<AccountTransactionsGroup[]>(
      `/api/transactions/by-account?limit=${limit}`,
    ),
  spendingByCategory: (params?: { from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    const qs = q.toString();
    return get<SpendingBreakdown>(
      `/api/spending/by-category${qs ? `?${qs}` : ""}`,
    );
  },
  spendingTransactions: (params: {
    category: string;
    from?: string;
    to?: string;
    includeExcluded?: boolean;
  }) => {
    const q = new URLSearchParams();
    q.set("category", params.category);
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    if (params.includeExcluded) q.set("include_excluded", "1");
    return get<SpendingTransactionsResponse>(`/api/spending/transactions?${q.toString()}`);
  },
  spendingItemsByCategory: (params: {
    parent: string;
    from?: string;
    to?: string;
  }) => {
    const q = new URLSearchParams();
    q.set("parent", params.parent);
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    return get<ItemsByCategory>(
      `/api/spending/items-by-category?${q.toString()}`,
    );
  },
  accountHoldingsHistory: (accountId: string, days = 90) =>
    get<HoldingsHistoryResponse>(`/api/accounts/${encodeURIComponent(accountId)}/holdings-history?days=${days ?? "all"}`),
  walletComposition: (address: string, date?: string) =>
    get<WalletCompositionResponse>(
      `/api/accounts/wallets/${encodeURIComponent(address)}/composition` +
        (date ? `?date=${date}` : ""),
    ),
  walletHistory: (address: string, days = 365) =>
    get<HoldingsHistoryResponse>(`/api/accounts/wallets/${encodeURIComponent(address)}/history?days=${days}`),
  bundleHistory: (institution: string, days = 365) =>
    get<HoldingsHistoryResponse>(
      `/api/accounts/bundle/${encodeURIComponent(institution)}/history?days=${days}`,
    ),
  createAccount: async (data: {
    display_name: string;
    category: string;
    institution?: string;
    balance: number;
    as_of?: string;
  }): Promise<Account> => {
    const res = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<Account>;
  },
  updateAccountBalance: async (
    accountId: string,
    data: { balance: number; as_of: string },
  ): Promise<{ id: string; as_of: string; expected_usd: number }> => {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  setAccountActive: async (accountId: string, active: 0 | 1) => {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  deleteAccount: async (accountId: string): Promise<{ ok: true }> => {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  patchAccountName: async (
    accountId: string,
    override: string | null,
  ): Promise<{ id: string; display_name_override: string | null }> => {
    const res = await fetch(
      `/api/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name_override: override }),
      },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  patchItemCategory: async (
    itemId: number,
    patch: { category: string | null; subcategory: string | null },
  ): Promise<{
    ok: true;
    id: number;
    /** Present only when category was patched; absent when only subcategory changed. */
    category?: string | null;
    keyword_learned: string | null;
    reclassified: number;
  }> => {
    const res = await fetch(`/api/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  patchTransactionExcluded: async (
    txnId: string,
    excluded: boolean,
  ): Promise<{ ok: true; excluded: boolean }> => {
    const res = await fetch(`/api/spending/transactions/${txnId}/exclude`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  bulkPatchItemCategory: async (
    ids: number[],
    patch: { category?: string | null; subcategory?: string | null },
  ): Promise<{ ok: true; items_updated: number }> => {
    const res = await fetch("/api/items/categories/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, ...patch }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  mergeCategories: async (
    from: string,
    to: string,
  ): Promise<{ from: string; to: string; items_updated: number }> => {
    const res = await fetch("/api/items/categories/merge", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  itemCategories: () =>
    get<CategoryHierarchy>("/api/items/categories"),
  cashflow: () => get<CashflowResponse>("/api/cashflow"),
  patchCashflow: async (
    patch: Record<string, number | string | null>,
  ): Promise<{ ok: boolean }> => {
    const res = await fetch("/api/cashflow", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  debt: () => get<DebtSummary>("/api/debt"),
  patchDebtTerms: async (
    accountId: string,
    patch: Record<string, number | string | null>,
  ): Promise<{ id: string; ok: boolean }> => {
    const res = await fetch(`/api/debt/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  debtPlan: async (
    monthly_extra: number,
    strategy: DebtStrategy,
  ): Promise<DebtPlanResponse> => {
    const res = await fetch("/api/debt/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_extra, strategy }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  advisorModel: () => get<{ model: string }>("/api/advisor/model"),
  syncSimpleFIN: async (days = 365): Promise<SyncTriggerResponse> => {
    const res = await fetch(`/api/sync/simplefin?days=${days}`, { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  syncZerion: async (): Promise<SyncTriggerResponse> => {
    const res = await fetch("/api/sync/zerion", { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  syncDefillama: async (): Promise<SyncTriggerResponse> => {
    const res = await fetch("/api/sync/defillama", { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  syncAlchemy: async (): Promise<SyncTriggerResponse> => {
    const res = await fetch("/api/sync/alchemy", { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  syncGeckoterminal: async (): Promise<SyncTriggerResponse> => {
    const res = await fetch("/api/sync/geckoterminal", { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  syncCoinbase: async (): Promise<SyncTriggerResponse> => {
    const res = await fetch("/api/sync/coinbase", { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  bundles: (type?: BundleType) => {
    const q = type ? `?type=${type}` : "";
    return get<Omit<Bundle, "category_options">[]>(`/api/bundles${q}`);
  },
  bundle: (id: string) => get<BundleDetail>(`/api/bundles/${id}`),
  createBundle: async (data: {
    name: string;
    type: BundleType;
    notes?: string;
  }): Promise<Bundle> => {
    const res = await fetch("/api/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  addToBundle: async (
    bundleId: string,
    txnIds: number[],
  ): Promise<{ added: number }> => {
    const res = await fetch(`/api/bundles/${encodeURIComponent(bundleId)}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txn_ids: txnIds }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  searchBundleTransactions: (
    bundleId: string,
    params: { q?: string; from?: string; to?: string },
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    return get<TransactionRow[]>(
      `/api/bundles/${encodeURIComponent(bundleId)}/search?${qs.toString()}`,
    );
  },
  updateBundleCategoryOptions: async (
    bundleId: string,
    options: CategoryOption[],
  ): Promise<CategoryOption[]> => {
    const res = await fetch(
      `/api/bundles/${encodeURIComponent(bundleId)}/category_options`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category_options: options }),
      },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json() as { ok: true; category_options: CategoryOption[] };
    return data.category_options;
  },
  removeFromBundle: async (
    bundleId: string,
    txnIds: number[],
  ): Promise<{ removed: number }> => {
    const res = await fetch(`/api/bundles/${encodeURIComponent(bundleId)}/transactions`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txn_ids: txnIds }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  netWorthSeries: (granularity: "day" | "week" | "month" | "year" = "day") =>
    get<NetWorthPoint[]>(`/api/networth/series?granularity=${granularity}`),
  netWorthBreakdown: (granularity: "day" | "week" | "month" | "year" = "day") =>
    get<HoldingsHistoryResponse>(`/api/networth/breakdown?granularity=${granularity}`),
  investmentsSeries: (params?: {
    granularity?: string;
    from?: string;
    to?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.granularity) q.set("granularity", params.granularity);
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    const qs = q.toString();
    return get<InvestmentsSeriesResponse>(`/api/investments/series${qs ? `?${qs}` : ""}`);
  },
  investmentsCostBasis: () =>
    get<{
      crypto_buys: {
        currency: string;
        txn_count: number;
        total_cost_basis: number;
        total_qty: number;
      }[];
      crypto_sells: {
        currency: string;
        txn_count: number;
        total_cost_basis: number;
        realized_return: number;
      }[];
      snapshot_basis: {
        symbol: string;
        account_id: string;
        display_name: string;
        type: string;
        cost_basis: number;
        value_usd: number;
        quantity: number;
        as_of: string;
      }[];
      totals: {
        crypto_cost_basis: number;
        crypto_realized_return: number;
        snapshot_cost_basis: number;
        combined_cost_basis: number;
      };
    }>("/api/investments/cost-basis"),
  investmentsTrades: (params?: { from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    const qs = q.toString();
    return get<TradeRow[]>(`/api/investments/trades${qs ? `?${qs}` : ""}`);
  },
  investmentsRealizedSeries: (granularity = "month") =>
    get<InvestmentsRealizedSeriesResponse>(`/api/investments/realized-series?granularity=${granularity}`),
  investmentsHoldings: () => get<InvestmentsHoldingsResponse>("/api/investments/holdings"),
  investmentsDefiBreakdown: () =>
    get<{
      as_of: string;
      total: number;
      chains: {
        chain: string;
        label: string;
        total: number;
        wallets: {
          account_id: string;
          label: string;
          total: number;
          positions: {
            symbol: string;
            contract_address: string;
            quantity: number;
            value_usd: number;
          }[];
        }[];
      }[];
    }>("/api/investments/defi-breakdown"),
  basisOverrides: () => get<BasisOverride[]>("/api/investments/basis-overrides"),
  upsertBasisOverride: async (payload: {
    symbol: string;
    account_id?: string | null;
    cost_usd: number;
    quantity_at_entry?: number | null;
    note?: string | null;
  }) => {
    const res = await fetch("/api/investments/basis-overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  deleteBasisOverride: async (id: number) => {
    const res = await fetch(`/api/investments/basis-overrides/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  investmentsFlows: (params?: { from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    const qs = q.toString();
    return get<InvestmentFlowRow[]>(`/api/investments/flows${qs ? `?${qs}` : ""}`);
  },
  goals: {
    list: (includeArchived = false) =>
      get<GoalsListResponse>(
        `/api/goals${includeArchived ? "?include_archived=1" : ""}`,
      ),
    create: async (data: {
      name: string;
      target_amount: number;
      due_date?: string | null;
    }): Promise<Goal> => {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { goal: Goal };
      return body.goal;
    },
    update: async (
      id: number,
      patch: { name?: string; target_amount?: number; due_date?: string | null },
    ): Promise<Goal> => {
      const res = await fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { goal: Goal };
      return body.goal;
    },
    allocate: async (id: number, amount: number): Promise<Goal> => {
      const res = await fetch(`/api/goals/${id}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { goal: Goal };
      return body.goal;
    },
    archive: async (id: number): Promise<Goal> => {
      const res = await fetch(`/api/goals/${id}/archive`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { goal: Goal };
      return body.goal;
    },
    delete: async (id: number): Promise<{ ok: true }> => {
      const res = await fetch(`/api/goals/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    },
  },
};
