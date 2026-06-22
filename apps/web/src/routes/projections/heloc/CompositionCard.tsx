import type { Scenario, PortfolioComposition, SleeveParams } from "../../../../../../packages/shared/types";
import { DEFAULT_COMPOSITION } from "../../../../../../packages/shared/types";

type Props = {
  scenario: Scenario;
  onChange: (updater: (s: Scenario) => Scenario) => void;
};

const SLEEVE_LABELS = {
  equity: "Equity",
  bond: "Bond",
  ordIncome: "Ord. income",
} as const;

type SleeveKey = keyof typeof SLEEVE_LABELS;
const SLEEVE_KEYS: SleeveKey[] = ["equity", "bond", "ordIncome"];

export function CompositionCard({ scenario, onChange }: Props) {
  const composition = scenario.composition ?? DEFAULT_COMPOSITION;

  function updateSleeve(key: SleeveKey, patch: Partial<SleeveParams>) {
    onChange((s) => {
      const current = s.composition ?? DEFAULT_COMPOSITION;
      return {
        ...s,
        composition: {
          ...current,
          [key]: { ...current[key], ...patch },
        },
      };
    });
  }

  // Auto-normalize on blur: called whenever the user leaves any fraction slider.
  // This keeps fractions summing to exactly 1 without interrupting mid-drag edits.
  function normalizeFractions() {
    onChange((s) => {
      const current = s.composition ?? DEFAULT_COMPOSITION;
      const sum =
        current.equity.fraction +
        current.bond.fraction +
        current.ordIncome.fraction;
      if (sum === 0 || Math.abs(sum - 1) < 0.001) return s;
      return {
        ...s,
        composition: {
          equity:    { ...current.equity,    fraction: current.equity.fraction / sum },
          bond:      { ...current.bond,      fraction: current.bond.fraction / sum },
          ordIncome: { ...current.ordIncome, fraction: current.ordIncome.fraction / sum },
        },
      };
    });
  }

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-stone-900">Portfolio composition</div>
      {SLEEVE_KEYS.map((k) => (
        <SleeveRow
          key={k}
          label={SLEEVE_LABELS[k]}
          sleeve={composition[k]}
          onChange={(patch) => updateSleeve(k, patch)}
          onBlurFraction={normalizeFractions}
        />
      ))}
      <FractionsSummary composition={composition} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────

type SleeveRowProps = {
  label: string;
  sleeve: SleeveParams;
  onChange: (patch: Partial<SleeveParams>) => void;
  onBlurFraction: () => void;
};

function SleeveRow({ label, sleeve, onChange, onBlurFraction }: SleeveRowProps) {
  const pct = Math.round(sleeve.fraction * 100);

  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-medium text-stone-700">{label}</div>
      {/* Fraction slider row */}
      <div className="mb-2 flex items-center gap-2">
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={sleeve.fraction}
          onChange={(e) => onChange({ fraction: Number(e.target.value) })}
          onBlur={onBlurFraction}
          className="w-full"
        />
        <span className="w-10 shrink-0 text-right text-xs text-stone-600">{pct}%</span>
      </div>
      {/* Return + yield inputs */}
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Exp. return">
          <input
            type="number"
            step="0.1"
            value={(sleeve.expectedReturn * 100).toFixed(1)}
            onChange={(e) =>
              onChange({ expectedReturn: Number(e.target.value) / 100 })
            }
            className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
          />
        </Labeled>
        <Labeled label="Ord. yield">
          <input
            type="number"
            step="0.1"
            value={(sleeve.ordinaryYield * 100).toFixed(1)}
            onChange={(e) =>
              onChange({ ordinaryYield: Number(e.target.value) / 100 })
            }
            className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
          />
        </Labeled>
      </div>
    </div>
  );
}

function FractionsSummary({ composition }: { composition: PortfolioComposition }) {
  const sum =
    composition.equity.fraction +
    composition.bond.fraction +
    composition.ordIncome.fraction;
  const normalized = Math.abs(sum - 1) < 0.001;
  const display = `Σ = ${Math.round(sum * 100)}%`;

  return (
    <div
      className={`mt-1 text-right text-xs ${
        normalized ? "text-stone-400" : "text-amber-600"
      }`}
    >
      {display}
      {!normalized && " — will normalize on blur"}
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
