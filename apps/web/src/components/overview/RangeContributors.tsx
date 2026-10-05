import type { RangeContributors as Result } from "../../lib/contributors";

/** Biggest per-account movers for the range dragged on the net worth chart. */
export function RangeContributors({
  startDate,
  endDate,
  result,
  loading,
  formatAmount,
}: {
  startDate: string;
  endDate: string;
  result: Result | null;
  loading: boolean;
  formatAmount: (n: number) => string;
}) {
  const signed = (n: number) => (n >= 0 ? "+" : "−") + formatAmount(Math.abs(n));
  const tone = (n: number) => (n >= 0 ? "text-emerald-600" : "text-rose-500");
  const maxAbs = Math.max(1, ...(result?.top ?? []).map((c) => Math.abs(c.delta)));

  return (
    <div data-testid="range-contributors" className="mt-3 rounded-md border border-stone-200 px-3 py-2">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-stone-600">
          Top contributors · {startDate} → {endDate}
        </span>
        {result && (
          <span className={`font-mono text-xs tabular-nums ${tone(result.total)}`}>
            {signed(result.total)}
          </span>
        )}
      </div>
      {loading ? (
        <div className="text-xs text-stone-400">loading…</div>
      ) : !result || result.top.length === 0 ? (
        <div className="text-xs text-stone-400">No account changed in this range.</div>
      ) : (
        <ul className="space-y-1">
          {result.top.map((c) => (
            <li key={c.label} className="grid grid-cols-[minmax(0,1fr)_5rem_6.5rem] items-center gap-2 text-xs">
              <span className="truncate text-stone-700" title={c.label}>{c.label}</span>
              <span className="flex h-1.5 justify-end overflow-hidden rounded-full bg-stone-100">
                <span
                  className={c.delta >= 0 ? "bg-emerald-400" : "bg-rose-400"}
                  style={{ width: `${(Math.abs(c.delta) / maxAbs) * 100}%` }}
                />
              </span>
              <span className={`text-right font-mono tabular-nums ${tone(c.delta)}`}>{signed(c.delta)}</span>
            </li>
          ))}
          {Math.abs(result.other) >= 0.005 && (
            <li className="grid grid-cols-[minmax(0,1fr)_5rem_6.5rem] items-center gap-2 text-xs">
              <span className="text-stone-400">Everything else</span>
              <span />
              <span className={`text-right font-mono tabular-nums ${tone(result.other)}`}>{signed(result.other)}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
