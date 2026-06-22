import { Fragment, useState } from "react";
import { formatCategory } from "../../../../packages/shared/categories";
import type { CategoryHierarchy, TransactionItem, TransactionRow } from "../lib/api";
import { formatDate } from "../lib/format";
import { usePrivateFormat } from "../lib/privacy";
import {
  useBulkPatchItemCategory,
  useBundleDetail,
  useItemCategories,
  usePatchItemCategory,
} from "../lib/queries";
import { CategoryDropdown } from "./CategoryDropdown";

interface Props {
  txn: TransactionRow;
  /** Hide the category pill when the caller is already grouping by category (e.g., /spending). */
  showCategoryBadge?: boolean;
  /**
   * Optional item-category filter. When set, only items whose `category`
   * matches are shown in the dropdown, the dropdown is auto-expanded, and
   * the item count badge reflects the filtered count. Pass the sentinel
   * "__unclassified__" to match items where category is NULL.
   */
  filterItemCategory?: string | null;
  /** Right-click handler. When set, suppresses the native context menu
   *  on this row and reports cursor coords to the caller. Spending page
   *  uses this to open the "Ignore in spending" / "Un-ignore" menu. */
  onContextMenu?: (
    txnId: string,
    currentlyExcluded: boolean,
    coords: { x: number; y: number },
  ) => void;
  /** When provided, an extra leading cell is rendered with a checkbox.
   *  The row's checkbox toggles every item in the row (or every visible
   *  item, when filterItemCategory is set). When some-but-not-all of a
   *  row's items are selected, the checkbox renders in indeterminate
   *  state. Rows with zero items render an empty placeholder cell so
   *  column widths stay aligned. */
  selection?: {
    selectedItemIds: Set<number>;
    onToggle: (itemIds: number[]) => void;
  };
  accountNames?: Map<string, string>;
  /** When true, render a transaction-level category control that applies the
   *  chosen category to ALL of the transaction's line items at once (it
   *  ripples to the sub-items). Used by the Spending drill-down, where the
   *  per-transaction inline badge is otherwise suppressed. */
  categorizeTransaction?: boolean;
}

export const UNCLASSIFIED_SENTINEL = "__unclassified__";

/**
 * One transaction's row, with an expandable sub-row of line items when
 * the transaction has a matched receipt. This is the canonical rendering
 * used by both the Transactions and Spending pages so the two views stay
 * in lockstep on data and interactions.
 */
export function TransactionTableRow({
  txn,
  showCategoryBadge = true,
  filterItemCategory = null,
  onContextMenu: onRowContextMenu,
  selection,
  accountNames,
  categorizeTransaction = false,
}: Props) {
  const fmt = usePrivateFormat();
  const allItems = txn.items ?? [];
  let items = allItems;
  if (filterItemCategory) {
    items = items.filter((it) =>
      filterItemCategory === UNCLASSIFIED_SENTINEL
        ? it.category == null
        : it.category === filterItemCategory,
    );
  }
  const hasItems = items.length > 0;
  const hasReceipt = !!txn.receipt;
  // Auto-expand when a filter is active so the matching items are visible.
  const [open, setOpen] = useState<boolean>(!!filterItemCategory);

  // Determine if this is a "single-item" row — either a synthesized item
  // (unitemized txn that got a synthetic item) or a receipt with exactly
  // one line item.  In that case we show a CategoryDropdown inline.
  // Multi-item rows show a category summary + clickable expand toggle.
  const isSingleItem = allItems.length === 1;
  const isMultiItem = allItems.length > 1;

  // Selection state spans every visible item: the row checkbox toggles
  // them all (post-filter), and renders indeterminate when only some
  // are selected. Toggling against the filtered subset means a row
  // showing only "unclassified" items won't accidentally re-tag the
  // row's already-classified items.
  const selectableIds = items.map((it) => it.id);
  const selectedCount = selection
    ? selectableIds.filter((id) => selection.selectedItemIds.has(id)).length
    : 0;
  const selectionState: "none" | "partial" | "all" =
    selectedCount === 0
      ? "none"
      : selectedCount === selectableIds.length
        ? "all"
        : "partial";

  return (
    <Fragment>
      <tr
        data-testid={`txn-row-${txn.id}`}
        className={txn.excluded_from_spending ? "opacity-50" : undefined}
        onContextMenu={
          onRowContextMenu
            ? (e) => {
                e.preventDefault();
                onRowContextMenu(txn.id, !!txn.excluded_from_spending, { x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      >
        {selection && (
          <td className="w-8 pl-4 pr-0 py-1.5 align-middle">
            {selectableIds.length > 0 && (
              <input
                type="checkbox"
                aria-label={`Select ${txn.description}`}
                checked={selectionState === "all"}
                ref={(el) => {
                  if (el) el.indeterminate = selectionState === "partial";
                }}
                onChange={() => selection.onToggle(selectableIds)}
                className="h-4 w-4 cursor-pointer rounded border-stone-300 text-violet-600 focus:ring-violet-500"
              />
            )}
          </td>
        )}
        <td className="whitespace-nowrap px-4 py-1.5 text-stone-500">
          {formatDate(txn.date)}
        </td>
        <td className="px-4 py-1.5 text-stone-800">
          <div className="flex flex-wrap items-center gap-2">
            {hasItems ? (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="text-xs text-stone-400 transition-colors hover:text-stone-700"
                title={`${items.length} item${items.length === 1 ? "" : "s"}`}
              >
                {open ? "▾" : "▸"}
              </button>
            ) : (
              <span className="w-2.5" />
            )}
            <span className="text-stone-800">{txn.description}</span>

            {/* Single-item: inline CategoryDropdown.
                Suppressed when the caller is already grouping by category
                (e.g., /spending), matching the pre-Task-10 badge behavior. */}
            {isSingleItem && showCategoryBadge && (
              <SingleItemCategoryDropdown
                item={allItems[0]}
                bundleId={txn.bundle_id}
              />
            )}

            {/* Multi-item: category summary text (click to expand) */}
            {isMultiItem && showCategoryBadge && (
              <MultiItemCategorySummary
                items={allItems}
                onExpand={() => setOpen((v) => !v)}
              />
            )}

            {/* Transaction-level categorize: one dropdown that applies the
                chosen category to every line item in the transaction. */}
            {categorizeTransaction && hasItems && (
              <TransactionCategoryDropdown txn={txn} />
            )}

            {hasReceipt && (
              <a
                href={`https://mail.google.com/mail/u/0/#all/${txn.receipt!.email_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-80 ${
                  txn.receipt!.match_status === "uncertain"
                    ? "bg-amber-50 text-amber-700"
                    : "bg-violet-50 text-violet-700"
                }`}
                title={`Open receipt email in Gmail${
                  txn.receipt!.merchant ? ` · ${txn.receipt!.merchant}` : ""
                }${txn.receipt!.order_id ? ` · #${txn.receipt!.order_id}` : ""} · ${txn.receipt!.match_status} match`}
              >
                receipt ↗
              </a>
            )}
            {isMultiItem && (
              <span className="text-[11px] text-stone-400">
                {items.length} item{items.length === 1 ? "" : "s"}
              </span>
            )}
            {txn.tags
              ?.split(",")
              .filter(Boolean)
              .map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700"
                >
                  {tag}
                </span>
              ))}
            {txn.excluded_from_spending && (
              <span className="rounded-full bg-stone-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-600">
                ignored
              </span>
            )}
          </div>
        </td>
        {accountNames && (
          <td className="whitespace-nowrap px-4 py-1.5 text-xs text-stone-400">
            {accountNames.get(txn.account_id) ?? txn.account_id}
          </td>
        )}
        <td
          className={`px-4 py-1.5 text-right font-mono tabular-nums ${
            txn.amount < 0 ? "text-stone-700" : "text-emerald-700"
          }`}
        >
          {fmt.amount(txn.amount, { cents: true })}
        </td>
      </tr>
      {hasItems && open && (
        <tr className="bg-stone-50/60">
          {selection && <td />}
          <td />
          <td colSpan={accountNames ? 3 : 2} className="px-4 pb-3 pt-1">
            <ul className="space-y-0.5 text-xs text-stone-600">
              {items.map((it) => {
                // Prefer the LLM-shortened name; fall back to the raw
                // product title (hard-capped at 100 chars). Either way,
                // the full raw name goes into the hover title so nothing
                // is lost.
                const display =
                  it.short_name ??
                  (it.name.length > 100
                    ? it.name.slice(0, 100).trimEnd() + "…"
                    : it.name);
                return (
                  <li
                    key={it.id}
                    className="flex items-baseline justify-between gap-4"
                  >
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      {it.quantity && it.quantity > 1 && (
                        <span className="text-stone-400">{it.quantity}×</span>
                      )}
                      <span className="truncate" title={it.name}>
                        {display}
                      </span>
                      <SingleItemCategoryDropdown
                        item={it}
                        bundleId={txn.bundle_id}
                      />
                    </span>
                    <span className="font-mono tabular-nums text-stone-500">
                      {it.line_total != null
                        ? fmt.amount(-it.line_total, { cents: true })
                        : it.unit_price != null
                          ? fmt.amount(-it.unit_price, { cents: true })
                          : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ---------------------------------------------------------------------------
// SingleItemCategoryDropdown
// Renders a CategoryDropdown for a single item, fetching global hierarchy
// and bundle suggestions as needed.
// ---------------------------------------------------------------------------

function SingleItemCategoryDropdown({
  item,
  bundleId,
}: {
  item: TransactionItem;
  bundleId: string | null;
}) {
  const categoriesQ = useItemCategories();
  const hierarchy: CategoryHierarchy = categoriesQ.data ?? [];

  const bundleQ = useBundleDetail(bundleId);
  const suggested: CategoryHierarchy = bundleQ.data?.category_options ?? [];

  const patchCategory = usePatchItemCategory();

  // Optimistic local state so the badge updates immediately on selection
  // without waiting for the parent's data to refetch from the server.
  // The parent props are mirrored via the prev-prop comparison pattern from
  // react.dev's "You Might Not Need an Effect" — adjusting state during
  // render avoids the extra render an effect would cause.
  const [localValue, setLocalValue] = useState<{
    category: string | null;
    subcategory: string | null;
  }>({ category: item.category, subcategory: item.subcategory });
  const [syncedFrom, setSyncedFrom] = useState<{
    category: string | null;
    subcategory: string | null;
  }>({ category: item.category, subcategory: item.subcategory });
  if (
    item.category !== syncedFrom.category ||
    item.subcategory !== syncedFrom.subcategory
  ) {
    setSyncedFrom({ category: item.category, subcategory: item.subcategory });
    setLocalValue({ category: item.category, subcategory: item.subcategory });
  }

  const handleChange = async (next: {
    category: string | null;
    subcategory: string | null;
  }) => {
    setLocalValue(next); // Optimistic: show new value right away.
    await patchCategory.mutateAsync({
      itemId: item.id,
      category: next.category,
      subcategory: next.subcategory,
    });
  };

  return (
    <CategoryDropdown
      value={localValue}
      onChange={handleChange}
      hierarchy={hierarchy}
      suggested={suggested}
      disabled={patchCategory.isPending}
    />
  );
}

// ---------------------------------------------------------------------------
// TransactionCategoryDropdown
// A transaction-level CategoryDropdown that bulk-applies the chosen category
// to every line item in the transaction (the "ripple to sub-items"). Shows
// the transaction's common category, or unset when its items disagree.
// ---------------------------------------------------------------------------

function TransactionCategoryDropdown({ txn }: { txn: TransactionRow }) {
  const items = txn.items ?? [];
  const categoriesQ = useItemCategories();
  const hierarchy: CategoryHierarchy = categoriesQ.data ?? [];
  const bundleQ = useBundleDetail(txn.bundle_id);
  const suggested: CategoryHierarchy = bundleQ.data?.category_options ?? [];
  const bulkPatch = useBulkPatchItemCategory();

  // Common value across items, or null when they disagree (shown as unset).
  const common = (pick: (it: TransactionItem) => string | null): string | null => {
    const distinct = new Set(items.map(pick));
    return distinct.size === 1 ? (items[0] ? pick(items[0]) : null) : null;
  };
  const derived = {
    category: common((it) => it.category),
    subcategory: common((it) => it.subcategory),
  };

  // Optimistic local state (mirrors SingleItemCategoryDropdown): update the
  // pill immediately, resync when the underlying items change after refetch.
  const [localValue, setLocalValue] = useState(derived);
  const [syncedSig, setSyncedSig] = useState(
    `${derived.category}|${derived.subcategory}`,
  );
  const derivedSig = `${derived.category}|${derived.subcategory}`;
  if (derivedSig !== syncedSig) {
    setSyncedSig(derivedSig);
    setLocalValue(derived);
  }

  const handleChange = async (next: {
    category: string | null;
    subcategory: string | null;
  }) => {
    setLocalValue(next);
    await bulkPatch.mutateAsync({
      ids: items.map((it) => it.id),
      category: next.category,
      subcategory: next.subcategory,
    });
  };

  return (
    <CategoryDropdown
      value={localValue}
      onChange={handleChange}
      hierarchy={hierarchy}
      suggested={suggested}
      disabled={bulkPatch.isPending}
    />
  );
}

// ---------------------------------------------------------------------------
// MultiItemCategorySummary
// Shows a compact "Cat1, Cat2, +N" badge for transactions with multiple
// items. Clicking expands to the items detail sub-row.
// ---------------------------------------------------------------------------

function MultiItemCategorySummary({
  items,
  onExpand,
}: {
  items: TransactionItem[];
  onExpand: () => void;
}) {
  // Collect unique non-null categories.
  const cats = [...new Set(items.map((it) => it.category).filter(Boolean))];

  const MAX_SHOW = 2;
  const shown = cats.slice(0, MAX_SHOW);
  const extra = cats.length - shown.length;

  if (cats.length === 0) {
    return (
      <button
        type="button"
        onClick={onExpand}
        className="rounded-full border border-dashed border-stone-300 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-stone-400 hover:border-violet-400 hover:text-violet-600"
        title="Click to expand items"
      >
        uncategorized
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onExpand}
      className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-stone-500 hover:bg-violet-50 hover:text-violet-700"
      title="Click to expand items and edit categories"
    >
      {shown.map((c) => formatCategory(c as string)).join(", ")}
      {extra > 0 && ` +${extra}`}
    </button>
  );
}
