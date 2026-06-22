import { Fragment, useMemo, useState } from "react";
import type { TransactionRow } from "../lib/api";
import { usePrivateFormat } from "../lib/privacy";
import { TransactionTableRow } from "./TransactionTableRow";

export type TxnSortKey = "date" | "description" | "amount";
export type TxnSortDir = "asc" | "desc";

interface Props {
  transactions: TransactionRow[];
  showCategoryBadge?: boolean;
  filterItemCategory?: string | null;
  defaultSortKey?: TxnSortKey;
  defaultSortDir?: TxnSortDir;
  /** When set, rows are grouped with a subtotal row per group, with
   *  groups ordered by descending total outflow. */
  groupBy?: "recipient";
  /** When supplied, rows bind onContextMenu and call this on right-click.
   *  The handler receives the txn id, the current excluded state, and the
   *  cursor coordinates so the parent can position a floating menu.
   *  When omitted, no context menu is bound (table stays clean elsewhere). */
  onTransactionContextMenu?: (
    txnId: string,
    currentlyExcluded: boolean,
    coords: { x: number; y: number },
  ) => void;
  /** When provided, every row with line items renders a checkbox in a
   *  leading column. Selection identifies items (since that's what gets
   *  recategorized), not transactions. Multi-item rows toggle every
   *  visible item (or every item, if no item-category filter is active)
   *  in the row at once, with an indeterminate state for partial
   *  selection. */
  selection?: {
    selectedItemIds: Set<number>;
    onToggle: (itemIds: number[]) => void;
  };
  /** Map of account_id → display name. When provided, an Account column
   *  is shown between Description and Amount. */
  accountNames?: Map<string, string>;
  /** Forwarded to each row: render a transaction-level category control that
   *  applies the chosen category to all of the transaction's line items. */
  categorizeTransaction?: boolean;
}

const RECIPIENT_PATTERNS: { test: RegExp; label: string }[] = [
  { test: /teamwork/i, label: "TeamWork Home Designs" },
  { test: /wheelhouse/i, label: "Wheelhouse Design" },
  { test: /home depot|homedepot/i, label: "Home Depot" },
  { test: /\bcheck\b/i, label: "Check" },
  { test: /zelle/i, label: "Zelle" },
];

function recipientLabel(t: TransactionRow): string {
  const raw = (t.merchant ?? t.payee ?? t.description).trim();
  if (!raw) return "—";
  for (const p of RECIPIENT_PATTERNS) if (p.test.test(raw)) return p.label;
  // Generic cleanup: drop trailing ACH junk like "SQ250812 T32H5K6RZ..."
  // and "WEB ID: 1234567890" so same-merchant rows collapse.
  return raw
    .replace(/\s+(SQ|ST-)\w+.*$/i, "")
    .replace(/\s+WEB ID:\s*\S+.*$/i, "")
    .replace(/\s+PPD ID:\s*\S+.*$/i, "")
    .replace(/\s+\d{6,}$/, "")
    .trim();
}

export function TransactionsTable({
  transactions,
  showCategoryBadge = true,
  filterItemCategory = null,
  defaultSortKey = "date",
  defaultSortDir = "desc",
  groupBy,
  onTransactionContextMenu,
  selection,
  accountNames,
  categorizeTransaction = false,
}: Props) {
  const [sortKey, setSortKey] = useState<TxnSortKey>(defaultSortKey);
  const [sortDir, setSortDir] = useState<TxnSortDir>(defaultSortDir);
  const fmt = usePrivateFormat();

  const handleSort = (key: TxnSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "description" ? "asc" : "desc");
    }
  };

  const cmp = (a: TransactionRow, b: TransactionRow): number => {
    let r: number;
    if (sortKey === "date") r = a.date.localeCompare(b.date);
    else if (sortKey === "amount") r = a.amount - b.amount;
    else r = a.description.localeCompare(b.description);
    return sortDir === "asc" ? r : -r;
  };

  const sorted = useMemo(
    () => [...transactions].sort(cmp),
    [transactions, sortKey, sortDir],
  );

  const groups = useMemo(() => {
    if (groupBy !== "recipient") return null;
    const byLabel = new Map<string, TransactionRow[]>();
    for (const t of sorted) {
      const label = recipientLabel(t);
      const rows = byLabel.get(label) ?? [];
      rows.push(t);
      byLabel.set(label, rows);
    }
    // Sort groups by outflow total desc (net of sign so credits don't win).
    return [...byLabel.entries()]
      .map(([label, rows]) => ({
        label,
        rows,
        total: rows.reduce((s, r) => s + r.amount, 0),
      }))
      .sort((a, b) => a.total - b.total);
  }, [sorted, groupBy]);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-stone-50 text-xs uppercase tracking-wider text-stone-500">
          {selection && <th className="w-8 px-4 py-2" />}
          <SortableTh label="Date" sortKey="date" active={sortKey} dir={sortDir} onSort={handleSort} />
          <SortableTh label="Description" sortKey="description" active={sortKey} dir={sortDir} onSort={handleSort} />
          {accountNames && <th className="px-4 py-2 text-left font-medium uppercase tracking-wider">Account</th>}
          <SortableTh label="Amount" sortKey="amount" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {groups
          ? groups.map((g) => (
              <Fragment key={g.label}>
                {g.rows.map((t) => (
                  <TransactionTableRow
                    key={t.id}
                    txn={t}
                    showCategoryBadge={showCategoryBadge}
                    filterItemCategory={filterItemCategory}
                    onContextMenu={onTransactionContextMenu}
                    selection={selection}
                    accountNames={accountNames}
                    categorizeTransaction={categorizeTransaction}
                  />
                ))}
                <tr className="bg-stone-50/70 text-xs">
                  {selection && <td />}
                  <td />
                  <td className="px-4 py-1.5 font-medium uppercase tracking-wider text-stone-500">
                    <div>
                      {g.label} subtotal · {g.rows.length} payment
                      {g.rows.length === 1 ? "" : "s"}
                    </div>
                  </td>
                  {accountNames && <td />}
                  <td
                    className={`px-4 py-1.5 text-right font-mono font-semibold tabular-nums ${
                      g.total < 0 ? "text-stone-800" : "text-emerald-700"
                    }`}
                  >
                    {fmt.amount(g.total, { cents: true })}
                  </td>
                </tr>
              </Fragment>
            ))
          : sorted.map((t) => (
              <TransactionTableRow
                key={t.id}
                txn={t}
                showCategoryBadge={showCategoryBadge}
                filterItemCategory={filterItemCategory}
                onContextMenu={onTransactionContextMenu}
                selection={selection}
                accountNames={accountNames}
                categorizeTransaction={categorizeTransaction}
              />
            ))}
      </tbody>
    </table>
  );
}


function SortableTh({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: TxnSortKey;
  active: TxnSortKey;
  dir: TxnSortDir;
  onSort: (k: TxnSortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = sortKey === active;
  const arrow = isActive ? (dir === "asc" ? "▲" : "▼") : "";
  return (
    <th className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-stone-800 ${
          isActive ? "text-stone-800" : ""
        }`}
      >
        <span>{label}</span>
        <span className="w-2 text-[10px] text-stone-400">{arrow}</span>
      </button>
    </th>
  );
}
