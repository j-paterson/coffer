import { useEffect, useRef, useState } from "react";
import type { FilingStatus, TaxProfile, TaxSuggestResponse } from "../../../../../packages/shared/types";

type Props = {
  onSaved: (tax: TaxProfile) => void;
  onCancel: () => void;
};

export function TaxProfileModal({ onSaved, onCancel }: Props) {
  const [status, setStatus] = useState<FilingStatus>("single");
  const [annualIncome, setAnnualIncome] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<TaxSuggestResponse | null>(null);
  const [elect, setElect] = useState(false);
  const [ordInc, setOrdInc] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/projections/tax-suggest?status=${status}`).then((r) => r.json()) as TaxSuggestResponse;
      if (cancelled) return;
      setAnnualIncome(Math.round(res.annualIncome));
      setSuggestion(res);
    })();
    return () => { cancelled = true; };
  }, []);

  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (annualIncome === null) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      const res = await fetch(`/api/projections/tax-suggest?status=${status}&income=${annualIncome}`).then((r) => r.json()) as TaxSuggestResponse;
      setSuggestion(res);
    }, 200);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [annualIncome, status]);

  async function save() {
    if (!suggestion) return;
    const profile: TaxProfile = {
      marginalOrdinaryRate: suggestion.marginalOrdinaryRate,
      ltcgRate: suggestion.ltcgRate,
      qualifiedDivRate: suggestion.qualifiedDivRate,
      ltcgElection: elect,
      ordinaryInvestmentIncomeMonthly: ordInc,
    };
    await fetch("/api/projections/tax-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(profile),
    });
    onSaved(profile);
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/30">
      <div className="w-[30rem] rounded-md bg-white p-5 shadow-lg">
        <div className="mb-4 text-lg font-semibold">Set your tax profile</div>

        <Row label="Filing status" hint="How you file your federal tax return — determines which bracket ranges apply to you.">
          <select value={status} onChange={(e) => setStatus(e.target.value as FilingStatus)} className="rounded border border-stone-200 px-2 py-1 text-sm">
            <option value="single">Single</option>
            <option value="mfj">Married filing jointly</option>
            <option value="hoh">Head of household</option>
          </select>
        </Row>

        <Row label="Annual income (gross)" hint="Your total pre-tax income for the year — wages, bonuses, self-employment, etc. Auto-filled from your cashflow settings; edit if it's off.">
          <div className="flex items-center gap-1">
            <span className="text-sm text-stone-500">$</span>
            <input
              type="number"
              step="1000"
              value={annualIncome ?? 0}
              onChange={(e) => setAnnualIncome(Number(e.target.value))}
              className="w-32 rounded border border-stone-200 px-2 py-1 text-sm text-right"
            />
          </div>
        </Row>

        <div className="my-3 border-t border-stone-200 pt-3">
          <div className="mb-2 text-xs uppercase tracking-wide text-stone-400">Derived rates (2025 federal{suggestion?.niitApplies ? " + NIIT" : ""}, TX 0% state)</div>
          <ReadOnlyRow label="Marginal ordinary rate" value={suggestion?.marginalOrdinaryRate} hint="The tax rate on your next dollar of wage or interest income." />
          <ReadOnlyRow label="LTCG rate" value={suggestion?.ltcgRate} hint="Long-term capital gains: tax on profits from investments held over a year." />
          <ReadOnlyRow label="Qualified div rate" value={suggestion?.qualifiedDivRate} hint="Tax on dividends from most US stocks you've held long enough." />
        </div>

        <Row label="LTCG inclusion election" hint="Advanced: treat long-term gains as ordinary income to deduct more investment interest. Leave unchecked unless your CPA says otherwise.">
          <input type="checkbox" checked={elect} onChange={(e) => setElect(e.target.checked)} />
        </Row>

        <Row label="Ordinary invest income (monthly)" hint="Average monthly interest, non-qualified dividends, and short-term gains from taxable accounts. From 1099-INT + 1099-DIV ÷ 12.">
          <input type="number" step="50" value={ordInc} onChange={(e) => setOrdInc(Number(e.target.value))} className="w-24 rounded border border-stone-200 px-2 py-1 text-sm" />
        </Row>

        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded border border-stone-200 px-3 py-1 text-sm" onClick={onCancel}>Cancel</button>
          <button className="rounded bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-50" onClick={save} disabled={!suggestion}>Save</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-sm text-stone-700">
        <span>{label}</span>
        {children}
      </div>
      {hint && <p className="mt-0.5 pr-2 text-xs italic text-stone-500">{hint}</p>}
    </div>
  );
}

function ReadOnlyRow({ label, value, hint }: { label: string; value?: number; hint: string }) {
  const display = value === undefined ? "…" : `${(value * 100).toFixed(1)}%`;
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between text-sm text-stone-700">
        <span>{label}</span>
        <span className="font-mono text-stone-900">{display}</span>
      </div>
      <p className="mt-0.5 pr-2 text-xs italic text-stone-500">{hint}</p>
    </div>
  );
}
