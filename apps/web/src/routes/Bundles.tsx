import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatCategory } from "../../../../packages/shared/categories";
import { BundleCategoryOptionsEditor } from "../components/BundleCategoryOptionsEditor";
import { LabeledDonut, type LabeledSlice } from "../components/LabeledDonut";
import { TransactionsTable } from "../components/TransactionsTable";
import {
  api,
  type Bundle,
  type BundleDetail,
  type BundleType,
  type TransactionRow,
} from "../lib/api";
import { formatDate } from "../lib/format";
import { usePrivacy, usePrivateFormat, privacyLabeledSlices } from "../lib/privacy";
import {
  queryKeys,
  useBundleDetail,
  useBundles,
  useUpdateBundleCategoryOptions,
} from "../lib/queries";

const BUNDLE_TYPE_LABELS: Record<BundleType, string> = {
  trip: "Trips",
  renovation: "Renovations",
  project: "Projects",
};

const BUNDLE_TYPE_COLORS: Record<BundleType, string> = {
  trip: "bg-sky-100 text-sky-800",
  renovation: "bg-amber-100 text-amber-800",
  project: "bg-violet-100 text-violet-800",
};

export function Bundles() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [typeFilter, setTypeFilter] = useState<BundleType | "all">("all");
  const [showCreate, setShowCreate] = useState(false);
  const fmt = usePrivateFormat();
  const qc = useQueryClient();
  const bundlesQ = useBundles();
  const bundles = bundlesQ.data ?? null;

  const invalidateBundles = () =>
    qc.invalidateQueries({ queryKey: queryKeys.bundles });

  function toggle(id: string) {
    setOpen((s) => ({ ...s, [id]: !s[id] }));
  }

  if (bundlesQ.error)
    return <pre className="text-red-700">{String(bundlesQ.error)}</pre>;
  if (!bundles) return <p className="text-stone-500">loading…</p>;

  const types = [...new Set(bundles.map((b) => b.type))].sort();
  const filtered =
    typeFilter === "all"
      ? bundles
      : bundles.filter((b) => b.type === typeFilter);
  const totalSpent = filtered.reduce((s, b) => s + Math.abs(b.total_usd), 0);

  return (
    <div className="max-w-5xl">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Bundles</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-stone-500">
            {filtered.length} bundle{filtered.length === 1 ? "" : "s"} ·{" "}
            {fmt.amount(totalSpent)} total
          </span>
          <button
            type="button"
            onClick={() => setShowCreate((s) => !s)}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800"
          >
            + New bundle
          </button>
        </div>
      </header>

      {showCreate && (
        <CreateBundleForm
          onCreated={() => {
            setShowCreate(false);
            invalidateBundles();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {types.length > 1 && (
        <div className="mb-4 flex gap-2">
          <FilterButton
            active={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
          >
            All
          </FilterButton>
          {types.map((t) => (
            <FilterButton
              key={t}
              active={typeFilter === t}
              onClick={() => setTypeFilter(t as BundleType)}
            >
              {BUNDLE_TYPE_LABELS[t as BundleType] ?? t}
            </FilterButton>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-stone-500">
          {typeFilter === "all"
            ? "No bundles yet. Create one or run `finance detect-trips` to auto-detect travel."
            : `No ${BUNDLE_TYPE_LABELS[typeFilter as BundleType]?.toLowerCase() ?? typeFilter} bundles yet.`}
        </p>
      ) : (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
          {filtered.map((b) => {
            const isOpen = !!open[b.id];
            const days =
              Math.round(
                (new Date(b.end_date).getTime() -
                  new Date(b.start_date).getTime()) /
                  (1000 * 60 * 60 * 24),
              ) + 1;
            return (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => toggle(b.id)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-stone-50"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="text-stone-400">
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold text-stone-900">
                          {b.name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${BUNDLE_TYPE_COLORS[b.type] ?? "bg-stone-100 text-stone-600"}`}
                        >
                          {b.type}
                        </span>
                      </div>
                      <div className="text-xs text-stone-500">
                        {formatDate(b.start_date)} → {formatDate(b.end_date)} ·{" "}
                        {days} day{days === 1 ? "" : "s"} · {b.txn_count} txns
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-lg font-semibold tabular-nums text-stone-900">
                      {fmt.amount(Math.abs(b.total_usd), { cents: true })}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-stone-100 bg-stone-50/50">
                    <BundleDetailPanel bundle={b} onAddedOrRemoved={invalidateBundles} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BundleDetailPanel({
  bundle,
  onAddedOrRemoved,
}: {
  bundle: Omit<Bundle, "category_options">;
  onAddedOrRemoved: () => void;
}) {
  const { data: detail, isLoading } = useBundleDetail(bundle.id);
  const qc = useQueryClient();
  if (isLoading && !detail) {
    return <p className="px-4 py-3 text-sm text-stone-500">loading…</p>;
  }
  if (!detail) return null;
  const hasTxns = detail.transactions.length > 0;
  return (
    <>
      {hasTxns ? (
        <BundleDetailView detail={detail} />
      ) : (
        <p className="px-4 py-3 text-sm text-stone-500">no transactions</p>
      )}
      {bundle.type !== "trip" && (
        <AddTransactions
          bundleId={bundle.id}
          onAdded={() => {
            qc.invalidateQueries({ queryKey: queryKeys.bundleDetail(bundle.id) });
            onAddedOrRemoved();
          }}
        />
      )}
    </>
  );
}

// Palette for category slices. Cycles if there are more categories than colors.
const CATEGORY_PALETTE = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#a78bfa",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

/** Aggregate item line_total by category across all transactions in a bundle. */
function aggregateByCategory(
  transactions: TransactionRow[],
): { category: string; total: number }[] {
  const map = new Map<string, number>();
  for (const txn of transactions) {
    if (txn.amount >= 0) continue; // skip credits/refunds
    if (txn.items && txn.items.length > 0) {
      for (const item of txn.items) {
        if (item.line_total == null || item.line_total >= 0) continue;
        const key = item.category ?? "Uncategorized";
        map.set(key, (map.get(key) ?? 0) + Math.abs(item.line_total));
      }
    } else {
      // No items: attribute the whole transaction amount to "Uncategorized"
      map.set("Uncategorized", (map.get("Uncategorized") ?? 0) + Math.abs(txn.amount));
    }
  }
  return [...map.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
}

function BundleDetailView({ detail }: { detail: BundleDetail }) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const updateCategoryOptions = useUpdateBundleCategoryOptions();
  const [showEditor, setShowEditor] = useState(false);

  const filteredTxns = selectedCategory
    ? detail.transactions.filter((t) =>
        t.amount < 0 &&
        (t.items && t.items.length > 0
          ? t.items.some(
              (item) =>
                item.line_total != null &&
                item.line_total < 0 &&
                (item.category ?? "Uncategorized") === selectedCategory,
            )
          : selectedCategory === "Uncategorized"),
      )
    : detail.transactions;

  return (
    <>
      <BundleCategoryChart
        detail={detail}
        selected={selectedCategory}
        onSelect={setSelectedCategory}
      />
      <div className="border-b border-stone-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setShowEditor((s) => !s)}
          className="text-xs font-medium text-stone-500 hover:text-stone-700"
        >
          {showEditor ? "Hide category options" : "Edit category options"}
        </button>
        {showEditor && (
          <div className="mt-2">
            <BundleCategoryOptionsEditor
              options={detail.category_options}
              onSave={async (next) => {
                await updateCategoryOptions.mutateAsync({
                  bundleId: detail.id,
                  options: next,
                });
              }}
            />
          </div>
        )}
      </div>
      <TransactionsTable transactions={filteredTxns} groupBy="recipient" />
    </>
  );
}

function BundleCategoryChart({
  detail,
  selected,
  onSelect,
}: {
  detail: BundleDetail;
  selected: string | null;
  onSelect: (cat: string | null) => void;
}) {
  const fmt = usePrivateFormat();
  const { enabled: privacyOn } = usePrivacy();
  const buckets = aggregateByCategory(detail.transactions);
  if (buckets.length === 0) return null;

  const rawSlices: LabeledSlice[] = buckets.map((b, i) => ({
    label: formatCategory(b.category),
    value: b.total,
    color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));
  const slices = privacyOn ? privacyLabeledSlices(rawSlices, "bundle_category") : rawSlices;

  const total = slices.reduce((s, x) => s + x.value, 0);
  const uncategorizedTotal =
    buckets.find((b) => b.category === "Uncategorized")?.total ?? 0;
  const categorized = total - uncategorizedTotal;
  const activeIndex = selected ? buckets.findIndex((b) => b.category === selected) : -1;

  return (
    <div className="border-b border-stone-100 px-4 py-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-stone-500">
          By category
        </span>
        {selected && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[10px] font-medium text-stone-500 hover:text-stone-800"
          >
            Filtering: {formatCategory(selected)} ✕
          </button>
        )}
      </div>
      <LabeledDonut
        slices={slices}
        size={180}
        thickness={32}
        width={460}
        centerLabel="categorized"
        centerValue={fmt.amount(categorized, { cents: true })}
        formatValue={(n) => fmt.amount(n, { cents: true })}
        activeIndex={activeIndex >= 0 ? activeIndex : null}
        onSliceClick={(i) => {
          const cat = buckets[i].category;
          onSelect(selected === cat ? null : cat);
        }}
      />
      {uncategorizedTotal > 0 && (
        <p className="mt-1 text-[10px] text-stone-400">
          {fmt.amount(uncategorizedTotal, { cents: true })} uncategorized — tag
          items in the table below to classify them.
        </p>
      )}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-stone-900 text-white"
          : "bg-stone-100 text-stone-600 hover:bg-stone-200"
      }`}
    >
      {children}
    </button>
  );
}

function AddTransactions({
  bundleId,
  onAdded,
}: {
  bundleId: string;
  onAdded: () => void;
}) {
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    import("../lib/api").TransactionRow[] | null
  >(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const fmt = usePrivateFormat();

  async function search() {
    if (!query.trim()) return;
    const rows = await api.searchBundleTransactions(bundleId, { q: query });
    setResults(rows);
    setSelected(new Set());
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelected() {
    if (selected.size === 0) return;
    setAdding(true);
    try {
      await api.addToBundle(
        bundleId,
        [...selected].map((id) => Number(id)),
      );
      setResults(null);
      setQuery("");
      setSelected(new Set());
      setShowSearch(false);
      onAdded();
    } finally {
      setAdding(false);
    }
  }

  if (!showSearch) {
    return (
      <div className="border-t border-stone-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setShowSearch(true)}
          className="text-xs font-medium text-stone-500 hover:text-stone-700"
        >
          + Add transactions
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-stone-100 px-4 py-3">
      <div className="mb-2 flex gap-2">
        <input
          type="text"
          placeholder="Search by merchant, description, memo…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          className="flex-1 rounded-md border border-stone-200 px-3 py-1.5 text-sm focus:border-stone-400 focus:outline-none"
          autoFocus
        />
        <button
          type="button"
          onClick={search}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800"
        >
          Search
        </button>
        <button
          type="button"
          onClick={() => {
            setShowSearch(false);
            setResults(null);
            setQuery("");
          }}
          className="rounded-md border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
        >
          Cancel
        </button>
      </div>
      {results && results.length === 0 && (
        <p className="py-2 text-xs text-stone-500">No matching transactions</p>
      )}
      {results && results.length > 0 && (
        <>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-stone-100">
              {results.map((txn) => {
                const inBundle = txn.bundle_id === bundleId;
                return (
                  <tr
                    key={`${txn.id}-${txn.account_id}`}
                    className={
                      inBundle ? "opacity-40" : "cursor-pointer hover:bg-white"
                    }
                    onClick={() => !inBundle && toggleSelect(txn.id)}
                  >
                    <td className="w-8 px-2 py-1.5">
                      {!inBundle && (
                        <input
                          type="checkbox"
                          checked={selected.has(txn.id)}
                          onChange={() => toggleSelect(txn.id)}
                          className="accent-stone-900"
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-stone-500">
                      {formatDate(txn.date)}
                    </td>
                    <td className="px-2 py-1.5 text-stone-800">
                      {txn.payee ?? txn.description}
                    </td>
                    <td className="px-2 py-1.5">
                      {txn.receipt ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                          receipt
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-stone-700">
                      {fmt.amount(txn.amount, { cents: true })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {selected.size > 0 && (
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={addSelected}
                disabled={adding}
                className="rounded-md bg-stone-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              >
                Add {selected.size} transaction{selected.size === 1 ? "" : "s"}
              </button>
              <span className="text-xs text-stone-500">
                {fmt.amount(
                  results
                    .filter((r) => selected.has(r.id))
                    .reduce((s, r) => s + Math.abs(r.amount), 0),
                  { cents: true },
                )}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CreateBundleForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<BundleType>("renovation");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.createBundle({
        name: name.trim(),
        type,
        notes: notes.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setSubmitError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-6 rounded-lg border border-stone-200 bg-white p-4"
    >
      <div className="mb-3 grid grid-cols-[1fr_auto] gap-3">
        <input
          type="text"
          placeholder="Bundle name (e.g. House Renovation 2025)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-200 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none"
          autoFocus
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as BundleType)}
          className="rounded-md border border-stone-200 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none"
        >
          <option value="renovation">Renovation</option>
          <option value="project">Project</option>
          <option value="trip">Trip</option>
        </select>
      </div>
      <textarea
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        className="mb-3 w-full rounded-md border border-stone-200 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none"
      />
      {submitError && (
        <p className="mb-2 text-xs text-rose-700">{submitError}</p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="rounded-md bg-stone-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
        >
          Create
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-stone-200 px-4 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
