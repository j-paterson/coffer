// Centralized query / mutation hooks. The rest of the app should pull
// data from here rather than calling api.* + useEffect directly. This
// gives us a single QueryClient cache, automatic dedup across
// components, refetch-on-window-focus, and clean invalidation when a
// mutation lands.

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { DebtStrategy } from "../../../../packages/shared/types";
import { api, type CategoryOption } from "./api";

// String constants so invalidation and tests can reference by name.
export const queryKeys = {
  accounts: ["accounts"] as const,
  summary: ["summary"] as const,
  debt: ["debt"] as const,
  cashflow: ["cashflow"] as const,
  itemCategories: ["item-categories"] as const,
  bundles: ["bundles"] as const,
  bundleDetail: (bundleId: string) => ["bundle-detail", bundleId] as const,
  holdingsHistory: (accountId: string, days: number) =>
    ["holdings-history", accountId, days] as const,
  transactionsByAccount: (limit: number) =>
    ["transactions-by-account", limit] as const,
  spendingByCategory: (params?: { from?: string; to?: string }) =>
    ["spending-by-category", params?.from, params?.to] as const,
  spendingItemsByCategory: (parent: string, params?: { from?: string; to?: string }) =>
    ["spending-items-by-category", parent, params?.from, params?.to] as const,
  spendingTransactions: (
    category: string,
    params?: { from?: string; to?: string; includeExcluded?: boolean },
  ) =>
    [
      "spending-transactions",
      category,
      params?.from,
      params?.to,
      params?.includeExcluded ?? false,
    ] as const,
  debtPlan: (extra: number, strategy: string) =>
    ["debt-plan", extra, strategy] as const,
};

export function useBundleDetail(bundleId: string | null) {
  return useQuery({
    queryKey: queryKeys.bundleDetail(bundleId ?? ""),
    queryFn: () => api.bundle(bundleId!),
    enabled: Boolean(bundleId),
  });
}

export function useBundles() {
  return useQuery({
    queryKey: queryKeys.bundles,
    queryFn: () => api.bundles(),
  });
}

export function useTransactionsByAccount(limit = 20) {
  return useQuery({
    queryKey: queryKeys.transactionsByAccount(limit),
    queryFn: () => api.transactionsByAccount(limit),
  });
}

export function useSpendingByCategory(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: queryKeys.spendingByCategory(params),
    queryFn: () => api.spendingByCategory(params),
  });
}

export function useSpendingItemsByCategory(
  parent: string | null,
  params?: { from?: string; to?: string },
) {
  return useQuery({
    queryKey: queryKeys.spendingItemsByCategory(parent ?? "", params),
    queryFn: () => api.spendingItemsByCategory({ parent: parent!, ...params }),
    enabled: Boolean(parent),
  });
}

export function useSpendingTransactions(
  category: string | null,
  params?: { from?: string; to?: string; includeExcluded?: boolean },
) {
  return useQuery({
    queryKey: queryKeys.spendingTransactions(category ?? "", params),
    queryFn: () =>
      api.spendingTransactions({
        category: category!,
        from: params?.from,
        to: params?.to,
        includeExcluded: params?.includeExcluded,
      }),
    enabled: Boolean(category),
  });
}

export function useDebtPlan(extra: number, strategy: DebtStrategy, enabled = true) {
  return useQuery({
    queryKey: queryKeys.debtPlan(extra, strategy),
    queryFn: () => api.debtPlan(extra, strategy),
    enabled,
  });
}

export function useAccounts() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: api.accounts,
  });
}

export function useSummary() {
  return useQuery({
    queryKey: queryKeys.summary,
    queryFn: api.summary,
  });
}

export function useDebt() {
  return useQuery({
    queryKey: queryKeys.debt,
    queryFn: api.debt,
  });
}

export function useCashflow() {
  return useQuery({
    queryKey: queryKeys.cashflow,
    queryFn: api.cashflow,
  });
}

export function useItemCategories() {
  return useQuery({
    queryKey: queryKeys.itemCategories,
    queryFn: api.itemCategories,
    // Categories don't change between renders unless a user just retagged.
    // Keep results around for a generous window so autocomplete is instant.
    staleTime: 60_000,
  });
}

export function useHoldingsHistory(accountId: string, days = 90) {
  return useQuery({
    queryKey: queryKeys.holdingsHistory(accountId, days),
    queryFn: () => api.accountHoldingsHistory(accountId, days),
    enabled: Boolean(accountId),
  });
}

export function useNetWorthSeries(
  granularity: "day" | "week" | "month" | "year" = "day",
) {
  return useQuery({
    queryKey: ["networth-series", granularity] as const,
    queryFn: () => api.netWorthSeries(granularity),
  });
}

export function useNetWorthBreakdown(
  granularity: "day" | "week" | "month" | "year" = "day",
  enabled = true,
) {
  return useQuery({
    queryKey: ["networth-breakdown", granularity] as const,
    queryFn: () => api.netWorthBreakdown(granularity),
    enabled,
  });
}

export function useWalletComposition(address: string, date?: string) {
  return useQuery({
    queryKey: ["wallet-composition", address, date ?? "today"] as const,
    queryFn: () => api.walletComposition(address, date),
    enabled: Boolean(address),
  });
}

export function useWalletHistory(address: string, days = 365) {
  return useQuery({
    queryKey: ["wallet-history", address, days] as const,
    queryFn: () => api.walletHistory(address, days),
    enabled: Boolean(address),
  });
}

export function useBundleHistory(institution: string, days = 365) {
  return useQuery({
    queryKey: ["bundle-history", institution, days] as const,
    queryFn: () => api.bundleHistory(institution, days),
    enabled: Boolean(institution),
  });
}

/** After mutating the DB, invalidate a fixed list of query keys. */
function useInvalidatingMutation<TArgs, TResult>(
  mutationFn: (args: TArgs) => Promise<TResult>,
  invalidate: readonly (readonly unknown[])[],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of invalidate) qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function usePatchAccountName() {
  return useInvalidatingMutation(
    ({ accountId, override }: { accountId: string; override: string | null }) =>
      api.patchAccountName(accountId, override),
    [queryKeys.accounts, queryKeys.summary],
  );
}

export function usePatchItemCategory() {
  return useInvalidatingMutation(
    ({
      itemId,
      category,
      subcategory,
    }: {
      itemId: number;
      category: string | null;
      subcategory: string | null;
    }) => api.patchItemCategory(itemId, { category, subcategory }),
    // Item changes affect the spending drill-down, the transactions
    // dropdown lists, the categories autocomplete, and any open bundle
    // detail (which feeds the category breakdown).
    [
      queryKeys.itemCategories,
      ["transactions-by-account"],
      ["spending-items-by-category"],
      ["spending-transactions"],
      ["bundle-detail"],
    ],
  );
}

export function useBulkPatchItemCategory() {
  return useInvalidatingMutation(
    ({
      ids,
      category,
      subcategory,
    }: {
      ids: number[];
      category?: string | null;
      subcategory?: string | null;
    }) => {
      const patch: { category?: string | null; subcategory?: string | null } = {};
      if (category !== undefined) patch.category = category;
      if (subcategory !== undefined) patch.subcategory = subcategory;
      return api.bulkPatchItemCategory(ids, patch);
    },
    // Same invalidation set as the single-item PATCH — bulk touches the
    // same caches.
    [
      queryKeys.itemCategories,
      ["transactions-by-account"],
      ["spending-items-by-category"],
      ["spending-transactions"],
      ["spending-by-category"],
      ["bundle-detail"],
    ],
  );
}

export function usePatchTransactionExcluded() {
  return useInvalidatingMutation(
    ({ txnId, excluded }: { txnId: string; excluded: boolean }) =>
      api.patchTransactionExcluded(txnId, excluded),
    [
      ["spending-transactions"],
      ["spending-by-category"],
      ["spending-items-by-category"],
    ],
  );
}

export function useMergeCategories() {
  return useInvalidatingMutation(
    ({ from, to }: { from: string; to: string }) =>
      api.mergeCategories(from, to),
    [
      queryKeys.itemCategories,
      ["transactions-by-account"],
      ["spending-items-by-category"],
      ["spending-transactions"],
      ["bundle-detail"],
    ],
  );
}

export function usePatchDebtTerms() {
  return useInvalidatingMutation(
    ({
      accountId,
      patch,
    }: {
      accountId: string;
      patch: Record<string, number | string | null>;
    }) => api.patchDebtTerms(accountId, patch),
    [queryKeys.debt, queryKeys.cashflow],
  );
}

export function usePatchCashflow() {
  return useInvalidatingMutation(
    (patch: Record<string, number | string | null>) => api.patchCashflow(patch),
    [queryKeys.cashflow],
  );
}

export function useAdvisorModel() {
  return useQuery({
    queryKey: ["advisor-model"] as const,
    queryFn: api.advisorModel,
    staleTime: Infinity,
  });
}

export function useSyncSimpleFIN() {
  return useMutation({ mutationFn: (days: number) => api.syncSimpleFIN(days) });
}

export function useSyncZerion() {
  return useMutation({ mutationFn: (_: void) => api.syncZerion() });
}

export function useInvestmentsSeries(
  granularity: "day" | "week" | "month" | "year" = "month",
  from?: string,
  to?: string,
) {
  return useQuery({
    queryKey: ["investments-series", granularity, from, to] as const,
    queryFn: () => api.investmentsSeries({ granularity, from, to }),
  });
}

export function useInvestmentsCostBasis() {
  return useQuery({
    queryKey: ["investments-cost-basis"] as const,
    queryFn: api.investmentsCostBasis,
  });
}

export function useInvestmentsTrades(from?: string, to?: string) {
  return useQuery({
    queryKey: ["investments-trades", from, to] as const,
    queryFn: () => api.investmentsTrades({ from, to }),
  });
}

export function useInvestmentsRealizedSeries(
  granularity: "day" | "week" | "month" | "year" = "month",
) {
  return useQuery({
    queryKey: ["investments-realized-series", granularity] as const,
    queryFn: () => api.investmentsRealizedSeries(granularity),
  });
}

export function useInvestmentsFlows(from?: string, to?: string) {
  return useQuery({
    queryKey: ["investments-flows", from, to] as const,
    queryFn: () => api.investmentsFlows({ from, to }),
  });
}

export function useInvestmentsHoldings() {
  return useQuery({
    queryKey: ["investments-holdings"] as const,
    queryFn: api.investmentsHoldings,
  });
}

export function useInvestmentsDefiBreakdown() {
  return useQuery({
    queryKey: ["investments-defi-breakdown"] as const,
    queryFn: api.investmentsDefiBreakdown,
  });
}

export function useBasisOverrides() {
  return useQuery({
    queryKey: ["basis-overrides"] as const,
    queryFn: api.basisOverrides,
  });
}

export function useUpsertBasisOverride() {
  return useInvalidatingMutation(
    (payload: {
      symbol: string;
      account_id?: string | null;
      cost_usd: number;
      quantity_at_entry?: number | null;
      note?: string | null;
    }) => api.upsertBasisOverride(payload),
    [["basis-overrides"], ["investments-holdings"]],
  );
}

export function useDeleteBasisOverride() {
  return useInvalidatingMutation(
    (id: number) => api.deleteBasisOverride(id),
    [["basis-overrides"], ["investments-holdings"]],
  );
}

export function useSyncDefillama() {
  return useMutation({ mutationFn: (_: void) => api.syncDefillama() });
}

export function useSyncAlchemy() {
  return useMutation({ mutationFn: (_: void) => api.syncAlchemy() });
}

export function useSyncGeckoterminal() {
  return useMutation({ mutationFn: (_: void) => api.syncGeckoterminal() });
}

export function useSyncCoinbase() {
  return useMutation({ mutationFn: (_: void) => api.syncCoinbase() });
}

// Order matters: SimpleFIN runs first so downstream parsers can reference
// the bank/card accounts it discovers. Price providers (defillama,
// geckoterminal) run after balance providers (zerion, alchemy, coinbase)
// so positions exist before prices are written. Do not reorder without
// understanding these dependencies.
const SYNC_ALL_ORDER = ["simplefin", "defillama", "zerion", "alchemy", "geckoterminal", "coinbase"] as const;
type ParserId = (typeof SYNC_ALL_ORDER)[number];

async function waitForRunFinish(runId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch("/api/sync/runs");
    if (!r.ok) throw new Error(`/api/sync/runs ${r.status}`);
    const snap = await r.json();
    if (!snap.current || snap.current.run_id !== runId) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
}

export function useSyncAllSequential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ completed: ParserId[]; failedAt: ParserId | null }> => {
      const completed: ParserId[] = [];
      const SYNC_FNS: Record<ParserId, () => Promise<{ run_id: string }>> = {
        simplefin: () => api.syncSimpleFIN(),
        defillama: () => api.syncDefillama(),
        zerion: () => api.syncZerion(),
        alchemy: () => api.syncAlchemy(),
        geckoterminal: () => api.syncGeckoterminal(),
        coinbase: () => api.syncCoinbase(),
      };
      for (const id of SYNC_ALL_ORDER) {
        let body: { run_id: string };
        try {
          body = await SYNC_FNS[id]();
        } catch {
          return { completed, failedAt: id };
        }
        await waitForRunFinish(body.run_id, 600_000);
        completed.push(id);
      }
      return { completed, failedAt: null };
    },
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
}

export function useUpdateBundleCategoryOptions() {
  // PATCH /api/bundles/:id/category_options writes only the bundle's
  // category_options JSON column. It does not touch transaction_items, so
  // the global /api/items/categories taxonomy doesn't need invalidation.
  return useInvalidatingMutation(
    ({ bundleId, options }: { bundleId: string; options: CategoryOption[] }) =>
      api.updateBundleCategoryOptions(bundleId, options),
    [["bundle-detail"]],
  );
}

export function useGoals(includeArchived = false) {
  return useQuery({
    queryKey: ["goals", includeArchived] as const,
    queryFn: () => api.goals.list(includeArchived),
  });
}

export function useCreateGoal() {
  return useInvalidatingMutation(
    (data: { name: string; target_amount: number; due_date?: string | null }) =>
      api.goals.create(data),
    [["goals"]],
  );
}

export function useUpdateGoal() {
  return useInvalidatingMutation(
    ({
      id,
      patch,
    }: {
      id: number;
      patch: { name?: string; target_amount?: number; due_date?: string | null };
    }) => api.goals.update(id, patch),
    [["goals"]],
  );
}

export function useAllocateGoal() {
  return useInvalidatingMutation(
    ({ id, amount }: { id: number; amount: number }) => api.goals.allocate(id, amount),
    [["goals"]],
  );
}

export function useArchiveGoal() {
  return useInvalidatingMutation(
    (id: number) => api.goals.archive(id),
    [["goals"]],
  );
}

export function useDeleteGoal() {
  return useInvalidatingMutation(
    (id: number) => api.goals.delete(id),
    [["goals"]],
  );
}
