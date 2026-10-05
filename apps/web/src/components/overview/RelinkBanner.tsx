import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RelinkPlan } from "../../lib/api";
import { usePrivateFormat } from "../../lib/privacy";

/** Shown when a reconnect at the aggregator minted new ids for accounts we
 *  already track. Nothing changes until the user reviews and confirms; the
 *  server backs the database up before merging. */
export function RelinkBanner() {
  const qc = useQueryClient();
  const { amount } = usePrivateFormat();
  const [open, setOpen] = useState(false);
  const planQ = useQuery({ queryKey: ["relink-plan"], queryFn: api.relinkPlan });
  const merge = useMutation({
    mutationFn: (plan: RelinkPlan) =>
      api.applyRelink(
        plan.pairs.map((p) => p.alias),
        plan.pairs.reduce((a, p) => a + p.duplicates.length, 0),
      ),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries();
    },
    // The plan moved under us (e.g. a sync landed): show the fresh one.
    onError: () => void qc.invalidateQueries({ queryKey: ["relink-plan"] }),
  });

  const plan = planQ.data;
  if (merge.data) {
    const removed = merge.data.merged.reduce((a, m) => a + m.removed, 0);
    return (
      <div data-testid="relink-banner" className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        Merged {merge.data.merged.length} reconnected account{merge.data.merged.length === 1 ? "" : "s"} and removed{" "}
        {removed} duplicate transaction{removed === 1 ? "" : "s"}. Backup: <span className="font-mono">{merge.data.backup}</span>
      </div>
    );
  }
  if (!plan || plan.pairs.length === 0) return null;

  const dupCount = plan.pairs.reduce((a, p) => a + p.duplicates.length, 0);
  const reviewCount = plan.pairs.reduce((a, p) => a + p.needs_review.length, 0);
  return (
    <div data-testid="relink-banner" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {plan.pairs.length} account{plan.pairs.length === 1 ? " was" : "s were"} reconnected with new ids, so they show up
          twice and {dupCount} transaction{dupCount === 1 ? " is" : "s are"} duplicated.
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 font-medium hover:bg-amber-100"
        >
          {open ? "Hide" : "Review & merge"}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {plan.pairs.map((p) => (
            <details key={p.alias} className="rounded border border-amber-200 bg-white px-2 py-1">
              <summary className="cursor-pointer">
                <span className="font-medium">{p.label}</span> · {p.duplicates.length} duplicate
                {p.duplicates.length === 1 ? "" : "s"} to remove
                {p.needs_review.length > 0 && ` · ${p.needs_review.length} possible duplicates kept for you to check`}
                {p.unmatched > 0 && ` · ${p.unmatched} with no match kept`}
              </summary>
              <ul className="mt-1 max-h-48 overflow-y-auto font-mono text-[11px] text-stone-600">
                {p.duplicates.map((d) => (
                  <li key={d.txn_id} className="flex gap-2">
                    <span>{d.date}</span>
                    <span className="flex-1 truncate">{d.description}</span>
                    <span className="tabular-nums">{amount(d.amount, { cents: true })}</span>
                  </li>
                ))}
              </ul>
              {p.needs_review.length > 0 && (
                <>
                  <div className="mt-1 text-stone-500">Kept — check these yourself (different text, or a transfer):</div>
                  <ul className="max-h-32 overflow-y-auto font-mono text-[11px] text-stone-500">
                    {p.needs_review.map((d) => (
                      <li key={d.txn_id} className="flex gap-2">
                        <span>{d.date}</span>
                        <span className="flex-1 truncate">{d.description}</span>
                        <span className="tabular-nums">{amount(d.amount, { cents: true })}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          ))}
          {plan.ambiguous.length > 0 && (
            <div className="text-stone-500">Left alone (more than one candidate): {plan.ambiguous.join(", ")}</div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={merge.isPending}
              onClick={() => merge.mutate(plan)}
              className="rounded-md bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {merge.isPending ? "Backing up & merging…" : `Merge ${plan.pairs.length} and remove ${dupCount} duplicates`}
            </button>
            <span className="text-stone-500">
              The database is backed up first.{reviewCount > 0 && ` ${reviewCount} possible duplicates are kept for you to check.`}
            </span>
          </div>
          {merge.isError && <div className="text-rose-600">Merge failed: {(merge.error as Error).message}</div>}
        </div>
      )}
    </div>
  );
}
