import type { Scenario } from "../../../../../../packages/shared/types";

type Props = {
  scenario: Scenario;
  onChange: (updater: (s: Scenario) => Scenario) => void;
};

export function TaxCard({ scenario, onChange }: Props) {
  const { tax } = scenario;
  const annualOrd = Math.round(tax.ordinaryInvestmentIncomeMonthly * 12);
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-stone-900">Tax assumptions</div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <ReadOnly label="Marginal ordinary">{(tax.marginalOrdinaryRate * 100).toFixed(1)}%</ReadOnly>
        <ReadOnly label="LTCG">{(tax.ltcgRate * 100).toFixed(1)}%</ReadOnly>
      </div>
      <Labeled label="Ord. invest income (annual)" hint="Bond/MMF/REIT ord. div. Caps §163(d) interest deduction.">
        <input
          data-testid="tax-ord-income-annual"
          type="number"
          step="1000"
          value={annualOrd}
          onChange={(e) => onChange((s) => ({
            ...s,
            tax: { ...s.tax, ordinaryInvestmentIncomeMonthly: Number(e.target.value) / 12 },
          }))}
          className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
        />
      </Labeled>
      <label className="mt-3 flex items-center gap-2 text-xs text-stone-600">
        <input
          type="checkbox"
          checked={tax.ltcgElection}
          onChange={(e) => onChange((s) => ({
            ...s,
            tax: { ...s.tax, ltcgElection: e.target.checked },
          }))}
        />
        §163(d)(4)(B): elect LTCG/QD as ordinary
      </label>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-stone-500">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[11px] italic text-stone-500">{hint}</p>}
    </div>
  );
}

function ReadOnly({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-stone-500">{label}</div>
      <div className="font-mono text-stone-900">{children}</div>
    </div>
  );
}
