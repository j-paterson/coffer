import { useMemo, useState } from "react";
import { TransactionsTable } from "../components/TransactionsTable";
import { usePrivateFormat } from "../lib/privacy";
import { useTransactionsByAccount } from "../lib/queries";

export function Transactions() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const fmt = usePrivateFormat();
  const groupsQ = useTransactionsByAccount(20);
  const groups = groupsQ.data ?? null;

  const totals = useMemo(() => {
    if (!groups) return null;
    return {
      accounts: groups.length,
      txns: groups.reduce((s, g) => s + g.count, 0),
    };
  }, [groups]);

  if (groupsQ.error) return <pre className="text-red-700">{String(groupsQ.error)}</pre>;
  if (!groups) return <p className="text-stone-500">loading…</p>;

  if (groups.length === 0) {
    return (
      <div className="max-w-5xl">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">
          Transactions
        </h1>
        <p className="text-stone-500">No transactions yet.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Transactions</h1>
        {totals && (
          <span className="text-sm text-stone-500">
            {totals.txns} txns across {totals.accounts} accounts
          </span>
        )}
      </header>

      <div className="space-y-4">
        {groups.map((g, i) => {
          // First group defaults to open; explicit user toggles override.
          const isOpen = open[g.account.id] ?? i === 0;
          const isLive = g.account.mode === "live";
          return (
            <section
              key={g.account.id}
              className="overflow-hidden rounded-lg border border-stone-200 bg-white"
            >
              <button
                type="button"
                onClick={() =>
                  setOpen((s) => ({ ...s, [g.account.id]: !isOpen }))
                }
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-stone-50"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="text-stone-400">{isOpen ? "▾" : "▸"}</span>
                  <span className="truncate text-sm font-medium text-stone-900">
                    {g.account.display_name}
                  </span>
                  {isLive ? (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                      live
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      stale
                    </span>
                  )}
                  <span className="text-xs text-stone-500">
                    {g.account.institution}
                  </span>
                </div>
                <div className="flex items-baseline gap-4 text-sm">
                  <span className="text-stone-500">{g.count} txns</span>
                  <span className="font-mono tabular-nums text-stone-700">
                    {fmt.amount(g.sum, { cents: true })}
                  </span>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-stone-100">
                  {g.transactions.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-stone-500">
                      no recent transactions
                    </p>
                  ) : (
                    <TransactionsTable transactions={g.transactions} />
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
