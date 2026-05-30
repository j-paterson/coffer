import type { Scenario, ScenarioEvent } from "../../../../../packages/shared/types";

type Props = { scenario: Scenario; onChange: (updater: (s: Scenario) => Scenario) => void };

const STRESS_RATE_RESET: ScenarioEvent = {
  kind: "rate_reset",
  atMonth: 36,
  payload: { loan_id: "heloc", new_apr: 0.0925 },
};
const STRESS_2008: ScenarioEvent = {
  kind: "market_shock",
  atMonth: 60,
  payload: { equity_drawdown_pct: 0.55, home_drawdown_pct: 0.25, duration_months: 24 },
};

export function StressCard({ scenario, onChange }: Props) {
  function toggle(ev: ScenarioEvent) {
    onChange((s) => {
      const has = s.events.some((e) => e.kind === ev.kind && e.atMonth === ev.atMonth);
      return {
        ...s,
        events: has
          ? s.events.filter((e) => !(e.kind === ev.kind && e.atMonth === ev.atMonth))
          : [...s.events, ev],
      };
    });
  }

  const rateOn = scenario.events.some((e) => e.kind === "rate_reset" && e.atMonth === 36);
  const crashOn = scenario.events.some((e) => e.kind === "market_shock" && e.atMonth === 60);

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-stone-900">Stress scenarios</div>
      <label className="mb-2 flex items-center gap-2 text-sm text-stone-700">
        <input type="checkbox" checked={rateOn} onChange={() => toggle(STRESS_RATE_RESET)} />
        Rate +200bps at year 3
      </label>
      <label className="flex items-center gap-2 text-sm text-stone-700">
        <input type="checkbox" checked={crashOn} onChange={() => toggle(STRESS_2008)} />
        2008-style shock at year 5
      </label>
    </div>
  );
}
