import { useState } from "react";

type Props = {
  onSaved: () => void;
};

export function HomeSetupModal({ onSaved }: Props) {
  const [homeValue, setHomeValue] = useState<number | "">("");
  const [hasMortgage, setHasMortgage] = useState(false);
  const [mortgageBalance, setMortgageBalance] = useState<number | "">("");
  const [mortgageAprPct, setMortgageAprPct] = useState<number | "">("");
  const [monthlyPayment, setMonthlyPayment] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const homeValid = typeof homeValue === "number" && homeValue > 0;
  const mortgageValid =
    !hasMortgage ||
    (typeof mortgageBalance === "number" &&
      mortgageBalance >= 0 &&
      typeof mortgageAprPct === "number" &&
      mortgageAprPct >= 0 &&
      mortgageAprPct < 100);

  async function save() {
    if (!homeValid || !mortgageValid) return;
    setSaving(true);
    setError(null);
    try {
      const body: {
        homeValue: number;
        mortgage?: { balance: number; apr: number; monthlyPayment?: number };
      } = { homeValue: homeValue as number };
      if (hasMortgage) {
        body.mortgage = {
          balance: mortgageBalance as number,
          apr: (mortgageAprPct as number) / 100,
          ...(typeof monthlyPayment === "number" && monthlyPayment > 0
            ? { monthlyPayment }
            : {}),
        };
      }
      const res = await fetch("/api/projections/home", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `request failed: ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/30">
      <div className="w-[30rem] rounded-md bg-white p-5 shadow-lg">
        <div className="mb-1 text-lg font-semibold">Set up your home</div>
        <p className="mb-4 text-xs text-stone-500">
          The Projections sandbox models borrowing against home equity to
          invest. Enter your home value and (optional) mortgage to get started.
          You can refine the numbers anytime from this page.
        </p>

        <Row
          label="Current home value"
          hint="Your best estimate of market value — county appraisal, Zillow, recent comp."
        >
          <MoneyInput value={homeValue} onChange={setHomeValue} step={5000} />
        </Row>

        <Row
          label="I have a mortgage"
          hint="If checked, mortgage balance is subtracted from equity in the sandbox."
        >
          <input
            type="checkbox"
            checked={hasMortgage}
            onChange={(e) => setHasMortgage(e.target.checked)}
          />
        </Row>

        {hasMortgage && (
          <div className="border-l-2 border-stone-100 pl-3">
            <Row label="Mortgage balance" hint="Outstanding principal owed.">
              <MoneyInput
                value={mortgageBalance}
                onChange={setMortgageBalance}
                step={1000}
              />
            </Row>
            <Row label="APR (%)" hint="Annual interest rate on the loan.">
              <PercentInput
                value={mortgageAprPct}
                onChange={setMortgageAprPct}
              />
            </Row>
            <Row
              label="Monthly payment (optional)"
              hint="Principal + interest. Defaults to 0.5% of balance if blank."
            >
              <MoneyInput
                value={monthlyPayment}
                onChange={setMonthlyPayment}
                step={50}
              />
            </Row>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            onClick={save}
            disabled={!homeValid || !mortgageValid || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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

function MoneyInput({
  value,
  onChange,
  step,
}: {
  value: number | "";
  onChange: (v: number | "") => void;
  step: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-sm text-stone-500">$</span>
      <input
        type="number"
        step={step}
        min={0}
        value={value}
        onChange={(e) =>
          onChange(e.target.value === "" ? "" : Number(e.target.value))
        }
        className="w-32 rounded border border-stone-200 px-2 py-1 text-right text-sm"
      />
    </div>
  );
}

function PercentInput({
  value,
  onChange,
}: {
  value: number | "";
  onChange: (v: number | "") => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        step={0.125}
        min={0}
        max={30}
        value={value}
        onChange={(e) =>
          onChange(e.target.value === "" ? "" : Number(e.target.value))
        }
        className="w-20 rounded border border-stone-200 px-2 py-1 text-right text-sm"
      />
      <span className="text-sm text-stone-500">%</span>
    </div>
  );
}
