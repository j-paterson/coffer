import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CategoryDropdown } from "../components/CategoryDropdown";
import {
  HorizontalStackedBar,
  type StackedSegment,
} from "../components/HorizontalStackedBar";
import { formatCategory } from "../../../../packages/shared/categories";
import { IgnoreContextMenu } from "../components/IgnoreContextMenu";
import { UNCLASSIFIED_SENTINEL } from "../components/TransactionTableRow";
import { TransactionsTable } from "../components/TransactionsTable";
import { Donut, type Slice } from "../lib/Donut";
import { api, type TransactionRow } from "../lib/api";
import { usePrivacy, usePrivateFormat, privacySlices } from "../lib/privacy";
import {
  useAccounts,
  useBulkPatchItemCategory,
  useItemCategories,
  useMergeCategories,
  usePatchTransactionExcluded,
  useSpendingByCategory,
  useSpendingItemsByCategory,
} from "../lib/queries";

// Each palette entry has matching bg + text variants so the donut (which
// uses currentColor → text-*) and the legend swatches/stacked bar (which
// use bg-*) stay in lockstep.
const PALETTE: { bg: string; text: string }[] = [
  { bg: "bg-emerald-500", text: "text-emerald-500" },
  { bg: "bg-amber-500", text: "text-amber-500" },
  { bg: "bg-rose-500", text: "text-rose-500" },
  { bg: "bg-sky-500", text: "text-sky-500" },
  { bg: "bg-violet-500", text: "text-violet-500" },
  { bg: "bg-orange-500", text: "text-orange-500" },
  { bg: "bg-teal-500", text: "text-teal-500" },
  { bg: "bg-pink-500", text: "text-pink-500" },
  { bg: "bg-indigo-500", text: "text-indigo-500" },
  { bg: "bg-lime-500", text: "text-lime-500" },
  { bg: "bg-cyan-500", text: "text-cyan-500" },
  { bg: "bg-fuchsia-500", text: "text-fuchsia-500" },
  { bg: "bg-yellow-500", text: "text-yellow-500" },
  { bg: "bg-red-500", text: "text-red-500" },
  { bg: "bg-stone-500", text: "text-stone-500" },
];

type TimeRange = "month" | "30d" | "90d" | "ytd" | "12mo" | "all";

const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "month", label: "This month" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "ytd", label: "YTD" },
  { value: "12mo", label: "12 months" },
  { value: "all", label: "All" },
];

function resolveRange(r: TimeRange): { from?: string; to?: string } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (r === "month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: iso(start), to: iso(today) };
  }
  if (r === "30d") {
    const start = new Date(today);
    start.setDate(today.getDate() - 29);
    return { from: iso(start), to: iso(today) };
  }
  if (r === "90d") {
    const start = new Date(today);
    start.setDate(today.getDate() - 89);
    return { from: iso(start), to: iso(today) };
  }
  if (r === "ytd") {
    return { from: `${today.getFullYear()}-01-01`, to: iso(today) };
  }
  if (r === "12mo") {
    const start = new Date(today);
    start.setFullYear(today.getFullYear() - 1);
    return { from: iso(start), to: iso(today) };
  }
  return {};
}

export function Spending() {
  const navigate = useNavigate();
  const params = useParams<{ category?: string }>();
  const selectedCategory = params.category
    ? decodeURIComponent(params.category)
    : null;

  type CategoryTxns = { rows: TransactionRow[]; excluded_count: number };
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [txnsByCategory, setTxnsByCategory] = useState<Record<string, CategoryTxns>>({});
  const [showIgnoredBy, setShowIgnoredBy] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<
    | { txnId: string; currentlyExcluded: boolean; x: number; y: number }
    | null
  >(null);
  const [loadingCat, setLoadingCat] = useState<Record<string, boolean>>({});
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [merging, setMerging] = useState(false);
  const [range, setRange] = useState<TimeRange>("month");
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(
    () => new Set(),
  );
  const mergeMut = useMergeCategories();
  const bulkMut = useBulkPatchItemCategory();
  const itemCategoriesQ = useItemCategories();
  const itemHierarchy = itemCategoriesQ.data ?? [];
  const fmt = usePrivateFormat();
  const { enabled: privacyOn } = usePrivacy();

  const dateRange = useMemo(() => resolveRange(range), [range]);

  const dataQ = useSpendingByCategory(dateRange);
  const data = dataQ.data ?? null;
  const itemsByCatQ = useSpendingItemsByCategory(selectedCategory, dateRange);
  const itemsByCat = itemsByCatQ.data ?? null;
  const accountsQ = useAccounts();
  const accountNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accountsQ.data ?? []) {
      map.set(a.id, a.display_name_override ?? a.display_name);
    }
    return map;
  }, [accountsQ.data]);
  const fetchError = dataQ.error ?? itemsByCatQ.error ?? null;

  // Reset per-category txn cache + subcategory filter when range or selected
  // category changes (react.dev's prev-prop comparison pattern; avoids the
  // extra render an effect would cause and the race between staged sets).
  const [prevDateRange, setPrevDateRange] = useState(dateRange);
  if (prevDateRange !== dateRange) {
    setPrevDateRange(dateRange);
    setTxnsByCategory({});
    setSelectedItemIds(new Set());
    setExcluded(new Set());
  }
  const [prevSelectedCategory, setPrevSelectedCategory] = useState(selectedCategory);
  if (prevSelectedCategory !== selectedCategory) {
    setPrevSelectedCategory(selectedCategory);
    setSelectedSub(null);
    setTxnsByCategory({});
    setSelectedItemIds(new Set());
  }

  // Eagerly preload transactions for the selected category so the drill-down
  // renders in one shot. Cancellation flag guards against the dateRange/category
  // changing mid-flight.
  useEffect(() => {
    if (!selectedCategory) return;
    let cancelled = false;
    setLoadingCat((s) => ({ ...s, [selectedCategory]: true }));
    api
      .spendingTransactions({
        category: selectedCategory,
        ...dateRange,
        includeExcluded: !!showIgnoredBy[selectedCategory],
      })
      .then((resp) => {
        if (cancelled) return;
        setTxnsByCategory((s) => ({ ...s, [selectedCategory]: resp }));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingCat((s) => ({ ...s, [selectedCategory]: false }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, dateRange]);

  const enriched = useMemo(() => {
    if (!data) return null;
    const includedTotal = data.rows.reduce(
      (acc, r) => (excluded.has(r.category) ? acc : acc + Math.abs(r.total)),
      0,
    );
    const denom = includedTotal || 1;
    return {
      totalIncluded: includedTotal,
      rows: data.rows.map((row, i) => {
        const included = !excluded.has(row.category);
        return {
          ...row,
          included,
          pct: included ? (Math.abs(row.total) / denom) * 100 : 0,
          color: PALETTE[i % PALETTE.length],
        };
      }),
    };
  }, [data, excluded]);

  const slices: Slice[] = useMemo(() => {
    if (!enriched) return [];
    const raw = enriched.rows
      .filter((r) => r.included)
      .map((r) => ({
        label: r.category,
        value: Math.abs(r.total),
        colorClass: r.color.text,
      }));
    return privacyOn ? privacySlices(raw, "spending") : raw;
  }, [enriched, privacyOn]);

  const subcategorySegments: StackedSegment[] = useMemo(() => {
    if (!itemsByCat) return [];
    return itemsByCat.subcategories.map((s, i) => ({
      label: s.category ?? "unclassified",
      displayLabel: formatCategory(s.category ?? "unclassified"),
      value: Math.abs(s.total),
      bgClass: PALETTE[i % PALETTE.length].bg,
    }));
  }, [itemsByCat]);

  function refetchCategoryTxns(category: string) {
    api
      .spendingTransactions({
        category,
        ...dateRange,
        includeExcluded: !!showIgnoredBy[category],
      })
      .then((resp) => {
        setTxnsByCategory((s) => ({ ...s, [category]: resp }));
      })
      .catch((e) => setError(String(e)));
  }

  function toggleCategory(category: string) {
    setExpanded((s) => ({ ...s, [category]: !s[category] }));
    if (!txnsByCategory[category] && !loadingCat[category]) {
      setLoadingCat((s) => ({ ...s, [category]: true }));
      api
        .spendingTransactions({
          category,
          ...dateRange,
          includeExcluded: !!showIgnoredBy[category],
        })
        .then((resp) => {
          setTxnsByCategory((s) => ({ ...s, [category]: resp }));
        })
        .catch((e) => setError(String(e)))
        .finally(() => {
          setLoadingCat((s) => ({ ...s, [category]: false }));
        });
    }
  }

  const patchExcluded = usePatchTransactionExcluded();

  // Toggle a row's items as a unit: if every id is already selected,
  // deselect them all; otherwise select them all. Same semantics whether
  // it comes from a single-item row's checkbox or a multi-item row's
  // (whose checkbox toggles all visible items at once).
  function toggleItemsSelection(itemIds: number[]) {
    if (itemIds.length === 0) return;
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      const allSelected = itemIds.every((id) => next.has(id));
      if (allSelected) for (const id of itemIds) next.delete(id);
      else for (const id of itemIds) next.add(id);
      return next;
    });
  }

  // Select every visible item across the drill-down (post-subcategory-
  // filter). When a subcategory filter is active, only matching items
  // are selected — so a multi-item row showing only "unclassified"
  // items won't pull its already-classified items into the selection.
  function selectAllVisible() {
    if (!selectedCategory) return;
    const cat = txnsByCategory[selectedCategory];
    if (!cat) return;
    const filterKey =
      selectedSub === "unclassified" ? UNCLASSIFIED_SENTINEL : selectedSub;
    const next = new Set<number>();
    for (const t of cat.rows) {
      for (const it of t.items ?? []) {
        if (
          !filterKey ||
          (filterKey === UNCLASSIFIED_SENTINEL
            ? it.category == null
            : it.category === filterKey)
        ) {
          next.add(it.id);
        }
      }
    }
    setSelectedItemIds(next);
  }

  async function applyBulkCategory(next: {
    category: string | null;
    subcategory: string | null;
  }) {
    if (selectedItemIds.size === 0) return;
    const ids = [...selectedItemIds];
    try {
      await bulkMut.mutateAsync({
        ids,
        category: next.category,
        subcategory: next.subcategory,
      });
      setSelectedItemIds(new Set());
    } catch (e) {
      setError(String(e));
    }
  }

  function handleContextMenu(
    txnId: string,
    currentlyExcluded: boolean,
    coords: { x: number; y: number },
  ) {
    setMenu({ txnId, currentlyExcluded, x: coords.x, y: coords.y });
  }

  async function applyExcludedToggle() {
    if (!menu) return;
    const { txnId, currentlyExcluded } = menu;
    const next = !currentlyExcluded;
    setMenu(null);
    // Optimistic: flip the row's flag (or remove it) in every cached
    // category bucket, and bump excluded_count. Donut/legend totals are
    // refreshed authoritatively after the PATCH — txns now split across
    // categories via item.line_total, so a single txn.amount no longer
    // captures the full per-category contribution.
    const snapshot = txnsByCategory;
    setTxnsByCategory((s) => {
      const out: Record<string, CategoryTxns> = {};
      for (const [cat, val] of Object.entries(s)) {
        const showingIgnored = !!showIgnoredBy[cat];
        let rows = val.rows;
        let excluded_count = val.excluded_count;
        const idx = rows.findIndex((r) => r.id === txnId);
        if (idx >= 0) {
          if (showingIgnored) {
            rows = rows.map((r, i) => (i === idx ? { ...r, excluded_from_spending: next } : r));
          } else {
            rows = rows.filter((_, i) => i !== idx);
          }
          excluded_count = excluded_count + (next ? 1 : -1);
        }
        out[cat] = { rows, excluded_count };
      }
      return out;
    });
    try {
      await patchExcluded.mutateAsync({ txnId, excluded: next });
      // patchExcluded already invalidates ["spending-by-category"], so the
      // donut/legend refetch authoritatively against the server (cheaper than
      // summing per-item on the client).
    } catch (e) {
      setError(String(e));
      setTxnsByCategory(snapshot);
    }
  }

  const displayError = error ?? (fetchError ? String(fetchError) : null);
  if (displayError) return <pre className="text-red-700">{displayError}</pre>;
  if (!data || !enriched) return <p className="text-stone-500">loading…</p>;

  return (
    <div className="flex h-full min-h-0 max-w-5xl flex-col">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Spending</h1>
        <div className="flex items-center gap-3">
          <div className="flex rounded-md border border-stone-200 bg-stone-50 p-0.5">
            {RANGE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setRange(o.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  range === o.value
                    ? "bg-white text-stone-900 shadow-sm"
                    : "text-stone-500 hover:text-stone-700"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-stone-500">
            {data.rows.length} categories
          </span>
        </div>
      </header>

      <div className="mb-4 flex flex-col items-center gap-6 rounded-lg border border-stone-200 bg-white p-6 md:flex-row md:items-center md:gap-10">
        <Donut
          slices={slices}
          size={240}
          thickness={42}
          centerLabel="Total spend"
          centerValue={fmt.amount(enriched.totalIncluded)}
          onSliceClick={(label) =>
            navigate(`/spending/${encodeURIComponent(label)}`)
          }
          selected={selectedCategory}
        />
        <div className="grid flex-1 grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {enriched.rows.map((row) => {
            const isSelected = selectedCategory === row.category;
            const dim = selectedCategory != null && !isSelected;
            const navigateRow = () =>
              navigate(
                isSelected
                  ? "/spending"
                  : `/spending/${encodeURIComponent(row.category)}`,
              );
            return (
              <div
                key={row.category}
                role="button"
                tabIndex={0}
                onClick={navigateRow}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigateRow();
                  }
                }}
                className={`flex cursor-pointer items-center justify-between rounded-md px-2 py-1 text-left text-sm transition-colors ${
                  isSelected
                    ? "bg-stone-900 text-white"
                    : "hover:bg-stone-100"
                } ${dim || !row.included ? "opacity-40" : ""}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={row.included}
                    aria-label={`${row.included ? "Exclude" : "Include"} ${formatCategory(row.category)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExcluded((s) => {
                        const next = new Set(s);
                        if (next.has(row.category)) next.delete(row.category);
                        else next.add(row.category);
                        return next;
                      });
                    }}
                    className={`inline-block h-3 w-3 rounded-sm border ${
                      row.included
                        ? `${row.color.bg} border-transparent`
                        : `bg-transparent border-current ${row.color.text}`
                    }`}
                  />
                  <span
                    className={`truncate ${isSelected ? "text-white" : "text-stone-700"}`}
                  >
                    {formatCategory(row.category)}
                  </span>
                </div>
                <div className="ml-2 flex items-baseline gap-2">
                  {row.included && (
                    <span
                      className={`text-xs tabular-nums ${
                        isSelected ? "text-stone-300" : "text-stone-400"
                      }`}
                    >
                      {row.pct.toFixed(0)}%
                    </span>
                  )}
                  <span
                    className={`font-mono tabular-nums ${
                      isSelected ? "text-white" : "text-stone-700"
                    } ${!row.included ? "line-through" : ""}`}
                  >
                    {fmt.amount(Math.abs(row.total))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
      {selectedCategory && (
        <section className="mb-6 rounded-lg border border-stone-200 bg-white">
          <header className="flex items-baseline justify-between border-b border-stone-100 px-4 py-3">
            <div className="flex items-baseline gap-3">
              <button
                type="button"
                onClick={() => navigate("/spending")}
                className="text-sm text-stone-500 hover:text-stone-700"
              >
                ← all categories
              </button>
              <h2 className="text-lg font-semibold text-stone-900">
                {formatCategory(selectedCategory)}
              </h2>
              {itemsByCat && (
                <span className="text-xs text-stone-500">
                  {itemsByCat.total_items} items ·{" "}
                  {itemsByCat.classified} classified ·{" "}
                  {itemsByCat.unclassified} unclassified
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setMergeFrom(selectedCategory);
                setMergeTarget("");
              }}
              className="text-xs text-stone-500 hover:text-stone-700"
            >
              Rename
            </button>
          </header>
          {mergeFrom && (
            <div className="flex items-center gap-2 border-b border-stone-100 bg-violet-50/50 px-4 py-2 text-xs">
              <span className="text-stone-600">
                {mergeFrom === selectedCategory ? "Rename" : "Merge"}{" "}
                <strong>{formatCategory(mergeFrom)}</strong>{" "}
                {mergeFrom === selectedCategory ? "to" : "into"}:
              </span>
              <input
                type="text"
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && mergeTarget.trim()) {
                    // A top-category rename retargets every item in the
                    // category (the backend updates category globally), so the
                    // old name disappears — navigate back to all categories.
                    // A subcategory merge stays put and just refetches.
                    const isCategoryRename = mergeFrom === selectedCategory;
                    setMerging(true);
                    try {
                      const result = await mergeMut.mutateAsync({
                        from: mergeFrom,
                        to: mergeTarget,
                      });
                      if (isCategoryRename) {
                        navigate("/spending");
                      } else {
                        refetchCategoryTxns(selectedCategory!);
                      }
                      alert(`Updated ${result.items_updated} items`);
                    } catch (err) {
                      alert(`Rename failed: ${err}`);
                    } finally {
                      setMerging(false);
                      setMergeFrom(null);
                      setMergeTarget("");
                    }
                  }
                  if (e.key === "Escape") {
                    setMergeFrom(null);
                    setMergeTarget("");
                  }
                }}
                disabled={merging}
                className="w-36 rounded border border-stone-300 px-1.5 py-0.5 outline-none focus:border-violet-400"
                placeholder="category name"
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  setMergeFrom(null);
                  setMergeTarget("");
                }}
                className="text-stone-400 hover:text-stone-700"
              >
                ✕
              </button>
            </div>
          )}
          <div className="px-4 py-4">
            {itemsByCat == null ? (
              <p className="text-sm text-stone-500">loading subcategories…</p>
            ) : itemsByCat.total_items === 0 ? (
              <p className="text-sm text-stone-500">
                No line-item detail available for this category yet. Items
                come from matched receipt emails — only Amazon and a handful
                of retailers contribute so far.
              </p>
            ) : (
              <>
              <HorizontalStackedBar
                segments={subcategorySegments}
                centerLabel={`${itemsByCat.total_items} items`}
                selected={selectedSub}
                onSegmentClick={(label) => setSelectedSub(label)}
                onSegmentMerge={(label) => {
                  setMergeFrom(label);
                  setMergeTarget("");
                }}
              />
              </>
            )}
          </div>
          {txnsByCategory[selectedCategory] && (
            <div className="border-t border-stone-100">
              {(() => {
                const cat = txnsByCategory[selectedCategory];
                const allTxns = cat?.rows ?? [];
                // When a subcategory is selected, only show transactions
                // whose items[] contains at least one match.
                const filterKey =
                  selectedSub === "unclassified"
                    ? UNCLASSIFIED_SENTINEL
                    : selectedSub;
                const visible = filterKey
                  ? allTxns.filter((t) =>
                      (t.items ?? []).some((it) =>
                        filterKey === UNCLASSIFIED_SENTINEL
                          ? it.category == null
                          : it.category === filterKey,
                      ),
                    )
                  : allTxns;
                return (
                  <>
                    {filterKey && (
                      <div className="flex items-center justify-between bg-stone-50 px-4 py-2 text-xs text-stone-600">
                        <span>
                          Filtered to <strong>{formatCategory(selectedSub)}</strong> ·{" "}
                          {visible.length} of {allTxns.length} transactions
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedSub(null)}
                          className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-medium text-stone-700 hover:bg-stone-300"
                        >
                          clear filter
                        </button>
                      </div>
                    )}
                    {(cat?.excluded_count ?? 0) > 0 && (
                      <div className="flex items-center gap-2 bg-stone-50 px-4 py-2 text-xs">
                        <button
                          type="button"
                          aria-pressed={!!showIgnoredBy[selectedCategory!]}
                          onClick={() =>
                            setShowIgnoredBy((s) => ({
                              ...s,
                              [selectedCategory!]: !s[selectedCategory!],
                            }))
                          }
                          className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-medium text-stone-700 hover:bg-stone-300"
                        >
                          {showIgnoredBy[selectedCategory!]
                            ? "Hide ignored"
                            : `Show ${cat!.excluded_count} ignored`}
                        </button>
                      </div>
                    )}
                    <TransactionsTable
                      transactions={visible}
                      showCategoryBadge={false}
                      filterItemCategory={filterKey}
                      onTransactionContextMenu={handleContextMenu}
                      selection={{
                        selectedItemIds,
                        onToggle: toggleItemsSelection,
                      }}
                      accountNames={accountNames}
                    />
                  </>
                );
              })()}
            </div>
          )}
          {loadingCat[selectedCategory] && (
            <p className="px-4 py-3 text-sm text-stone-500">
              loading transactions…
            </p>
          )}
        </section>
      )}

      <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
        {enriched.rows.map((row) => {
          const isOpen = !!expanded[row.category];
          const cat = txnsByCategory[row.category];
          const txns = cat?.rows;
          const excludedCount = cat?.excluded_count ?? 0;
          const isLoading = loadingCat[row.category];
          return (
            <li key={row.category}>
              <button
                type="button"
                onClick={() => toggleCategory(row.category)}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-stone-50"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    className={`inline-block h-3 w-3 rounded-sm ${row.color.bg}`}
                  />
                  <span className="text-stone-400">{isOpen ? "▾" : "▸"}</span>
                  <span className="text-sm font-medium text-stone-900">
                    {formatCategory(row.category)}
                  </span>
                  <span className="text-xs text-stone-500">
                    {row.count} txns
                  </span>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="text-xs text-stone-500 tabular-nums">
                    {row.pct.toFixed(1)}%
                  </span>
                  <span className="w-28 text-right font-mono text-sm tabular-nums text-stone-900">
                    {fmt.amount(Math.abs(row.total), { cents: true })}
                  </span>
                </div>
              </button>
              {isOpen && (
                <div className="border-t border-stone-100 bg-stone-50/50">
                  {isLoading && !txns ? (
                    <p className="px-4 py-3 text-sm text-stone-500">loading…</p>
                  ) : txns && (txns.length > 0 || excludedCount > 0) ? (
                    <>
                      {excludedCount > 0 && (
                        <div className="flex items-center gap-2 bg-stone-50 px-4 py-2 text-xs">
                          <button
                            type="button"
                            aria-pressed={!!showIgnoredBy[row.category]}
                            onClick={() => {
                              const next = !showIgnoredBy[row.category];
                              setShowIgnoredBy((s) => ({ ...s, [row.category]: next }));
                              // refetchCategoryTxns reads showIgnoredBy at call time, so we briefly
                              // shadow the just-set value by passing the new flag through the API call
                              // directly:
                              api
                                .spendingTransactions({
                                  category: row.category,
                                  ...dateRange,
                                  includeExcluded: next,
                                })
                                .then((resp) => {
                                  setTxnsByCategory((s) => ({ ...s, [row.category]: resp }));
                                })
                                .catch((e) => setError(String(e)));
                            }}
                            className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-medium text-stone-700 hover:bg-stone-300"
                          >
                            {showIgnoredBy[row.category]
                              ? "Hide ignored"
                              : `Show ${excludedCount} ignored`}
                          </button>
                        </div>
                      )}
                      <TransactionsTable
                        transactions={txns}
                        showCategoryBadge={false}
                        onTransactionContextMenu={handleContextMenu}
                        selection={{
                          selectedItemIds,
                          onToggle: toggleItemsSelection,
                        }}
                        accountNames={accountNames}
                      />
                    </>
                  ) : (
                    <p className="px-4 py-3 text-sm text-stone-500">
                      no transactions
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      </div>
      {menu && (
        <IgnoreContextMenu
          x={menu.x}
          y={menu.y}
          currentlyExcluded={menu.currentlyExcluded}
          onSelect={applyExcludedToggle}
          onDismiss={() => setMenu(null)}
        />
      )}
      {selectedItemIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-stone-200 bg-white px-4 py-2 shadow-lg">
          <span className="text-sm font-medium text-stone-700">
            {selectedItemIds.size} selected
          </span>
          <span className="text-stone-200">|</span>
          {selectedCategory && (
            <button
              type="button"
              onClick={selectAllVisible}
              className="text-sm text-stone-600 hover:text-stone-900"
            >
              Select all visible
            </button>
          )}
          <CategoryDropdown
            value={{ category: null, subcategory: null }}
            onChange={applyBulkCategory}
            hierarchy={itemHierarchy}
            disabled={bulkMut.isPending}
            triggerLabel={bulkMut.isPending ? "Saving…" : "Set category"}
            triggerClassName="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setSelectedItemIds(new Set())}
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
