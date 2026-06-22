import type { Scenario } from "../../../../../../packages/shared/types";

type Props = {
  scenario: Scenario;
  onChange: (updater: (s: Scenario) => Scenario) => void;
};

export function LoanCard({ scenario, onChange }: Props) {
  const loanEv = scenario.events.find((e) => e.kind === "take_loan");
  const investEv = scenario.events.find((e) => e.kind === "invest_cash");
  if (!loanEv || !investEv) return null;
  const principal = (loanEv.payload as any).principal as number;
  const apr = (loanEv.payload as any).apr as number;
  const termMonths = (loanEv.payload as any).term_months as number;

  function setPrincipal(v: number) {
    onChange((s) => ({
      ...s,
      events: s.events.map((e) => {
        if (e.kind === "take_loan") return { ...e, payload: { ...(e.payload as any), principal: v } };
        if (e.kind === "invest_cash") return { ...e, payload: { ...(e.payload as any), amount: v } };
        return e;
      }),
    }));
  }
  function setApr(v: number) {
    onChange((s) => ({
      ...s,
      events: s.events.map((e) => e.kind === "take_loan" ? { ...e, payload: { ...(e.payload as any), apr: v } } : e),
    }));
  }
  function setTerm(v: number) {
    onChange((s) => ({
      ...s,
      events: s.events.map((e) => e.kind === "take_loan" ? { ...e, payload: { ...(e.payload as any), term_months: v } } : e),
    }));
  }

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-stone-900">Home-equity loan</div>
      <Field label="Draw amount" fromLedger>
        <input data-testid="loan-draw-amount" type="number" value={principal} onChange={(e) => setPrincipal(Number(e.target.value))} className="w-full rounded border border-stone-200 px-2 py-1 text-sm" />
      </Field>
      <Field label="Rate (APR)">
        <input type="number" step="0.0025" value={apr} onChange={(e) => setApr(Number(e.target.value))} className="w-full rounded border border-stone-200 px-2 py-1 text-sm" />
      </Field>
      <Field label="Term (months)">
        <input type="number" value={termMonths} onChange={(e) => setTerm(Number(e.target.value))} className="w-full rounded border border-stone-200 px-2 py-1 text-sm" />
      </Field>
      <p className="mt-2 text-xs text-stone-500">
        Deductibility assumes loan proceeds are deposited into a dedicated, unmixed brokerage account (Temp. Reg. §1.163-8T).
      </p>
    </div>
  );
}

function Field({ label, children, fromLedger }: { label: string; children: React.ReactNode; fromLedger?: boolean }) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-stone-500">
        <span>{label}</span>
        {fromLedger && <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-600">from ledger</span>}
      </div>
      {children}
    </div>
  );
}
