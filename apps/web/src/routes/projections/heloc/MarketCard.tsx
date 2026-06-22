import type { Scenario } from "../../../../../../packages/shared/types";

type Props = {
  scenario: Scenario;
  onChange: (updater: (s: Scenario) => Scenario) => void;
};

export function MarketCard({ scenario, onChange }: Props) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-stone-900">Market assumptions</div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Labeled label="Expected return">
          <input type="number" step="0.005" value={scenario.baselineReturnPct}
                 onChange={(e) => onChange((s) => ({ ...s, baselineReturnPct: Number(e.target.value) }))}
                 className="w-full rounded border border-stone-200 px-2 py-1 text-sm" />
        </Labeled>
        <Labeled label="Volatility">
          <input type="number" step="0.01" value={scenario.baselineVolPct}
                 onChange={(e) => onChange((s) => ({ ...s, baselineVolPct: Number(e.target.value) }))}
                 className="w-full rounded border border-stone-200 px-2 py-1 text-sm" />
        </Labeled>
      </div>
      <Labeled label="Home appreciation">
        <input type="number" step="0.005" value={scenario.homeAppreciationPct}
               onChange={(e) => onChange((s) => ({ ...s, homeAppreciationPct: Number(e.target.value) }))}
               className="w-full rounded border border-stone-200 px-2 py-1 text-sm" />
      </Labeled>
      <label className="mt-3 flex items-center gap-2 text-xs text-stone-600">
        <input type="checkbox" checked={scenario.mc.enabled}
               onChange={(e) => onChange((s) => ({ ...s, mc: { ...s.mc, enabled: e.target.checked } }))} />
        Show Monte Carlo band ({scenario.mc.paths} paths)
      </label>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-stone-500">{label}</div>
      {children}
    </div>
  );
}
