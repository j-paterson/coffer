import { useMemo, useState } from "react";
import { formatCategory } from "../../../../packages/shared/categories";
import { LabeledDonut } from "../components/LabeledDonut";
import type { CashflowResponse, DebtPlanResponse } from "../lib/api";
import { usePrivacy, usePrivateFormat, privacyLabeledSlices } from "../lib/privacy";
import {
  useCashflow,
  useDebt,
  useDebtPlan,
  usePatchCashflow,
  usePatchDebtTerms,
} from "../lib/queries";
import type { DebtStrategy } from "../../../../packages/shared/types";

const REQUIRED_PALETTE = [
  "#10b981", // emerald
  "#f59e0b", // amber
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#f43f5e", // rose
  "#14b8a6", // teal
  "#ec4899", // pink
  "#f97316", // orange
];

const STRATEGY_LABELS: Record<DebtStrategy, string> = {
  avalanche: "Avalanche (highest APR first)",
  snowball: "Snowball (smallest balance first)",
  even: "Even (split extra across all)",
};

const PALETTE = [
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-stone-500",
];

export function Debt() {
  const fmt = usePrivateFormat();
  const debtQ = useDebt();
  const cashflowQ = useCashflow();
  const debt = debtQ.data;
  const cashflow = cashflowQ.data;
  const error = debtQ.error ?? cashflowQ.error;

  const [extraTouched, setExtraTouched] = useState(false);
  const [extra, setExtra] = useState(500);
  // First-load auto-fill: take "available_for_debt" once, unless the
  // user has already touched the input.
  if (!extraTouched && cashflow && extra === 500) {
    const suggested = Math.round(cashflow.available_for_debt);
    if (suggested !== 500) setExtra(suggested);
  }

  const [strategy, setStrategy] = useState<DebtStrategy>("avalanche");
  const [savingId, setSavingId] = useState<string | null>(null);
  const patchTerms = usePatchDebtTerms();

  // Each strategy fetches independently. React Query keys on (extra, strategy)
  // so rapid `extra` changes during typing only keep the latest in-flight
  // request per strategy and discard stale responses.
  const planAvalancheQ = useDebtPlan(extra, "avalanche", !!debt);
  const planSnowballQ = useDebtPlan(extra, "snowball", !!debt);
  const planEvenQ = useDebtPlan(extra, "even", !!debt);
  const plans: Record<DebtStrategy, typeof planAvalancheQ.data | null> = {
    avalanche: planAvalancheQ.data ?? null,
    snowball: planSnowballQ.data ?? null,
    even: planEvenQ.data ?? null,
  };

  const activePlan = plans[strategy];

  const updateApr = async (id: string, aprPct: number) => {
    setSavingId(id);
    try {
      await patchTerms.mutateAsync({
        accountId: id,
        patch: { apr: aprPct / 100 },
      });
    } finally {
      setSavingId(null);
    }
  };

  if (error) return <pre className="text-rose-700">{String(error)}</pre>;
  if (!debt) return <p className="text-stone-500">loading…</p>;

  return (
    <div className="max-w-5xl">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Debt</h1>
      </header>

      {cashflow && (
        <CashflowPanel
          cashflow={cashflow}
          fmt={fmt}
          onApplyAvailable={() => {
            setExtra(Math.round(cashflow.available_for_debt));
            setExtraTouched(true);
          }}
        />
      )}

      {/* Summary card */}
      <section className="mb-6 grid grid-cols-1 gap-4 rounded-lg border border-stone-200 bg-white p-5 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-stone-500">
            Total debt
          </div>
          <div className="font-mono text-2xl font-semibold text-rose-700">
            {fmt.amount(debt.total_debt, { cents: true })}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-stone-500">
            Weighted APR
          </div>
          <div className="font-mono text-2xl font-semibold text-stone-900">
            {(debt.weighted_avg_apr * 100).toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-stone-500">
            Monthly minimums
          </div>
          <div className="font-mono text-2xl font-semibold text-stone-900">
            {fmt.amount(debt.monthly_minimums, { cents: true })}
          </div>
        </div>
      </section>

      {/* Strategy + extra payment input */}
      <section className="mb-6 rounded-lg border border-stone-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-stone-500">
              Extra per month above minimums
            </label>
            <div className="flex items-center gap-2">
              <span className="text-stone-400">$</span>
              <input
                type="number"
                min={0}
                step={50}
                value={extra}
                onChange={(e) => setExtra(Math.max(0, Number(e.target.value)))}
                className="w-32 rounded border border-stone-300 px-2 py-1 font-mono text-lg"
              />
            </div>
            <div className="mt-1 text-xs text-stone-400">
              Total budget: {fmt.amount(debt.monthly_minimums + extra, { cents: true })}/mo
            </div>
          </div>
          <div className="flex flex-1 flex-wrap gap-2">
            {(Object.keys(STRATEGY_LABELS) as DebtStrategy[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStrategy(s)}
                className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                  strategy === s
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                }`}
              >
                {STRATEGY_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {/* Strategy comparison */}
        <div className="grid grid-cols-3 gap-2 border-t border-stone-100 pt-4 text-sm">
          {(Object.keys(STRATEGY_LABELS) as DebtStrategy[]).map((s) => {
            const p = plans[s];
            const isActive = strategy === s;
            return (
              <div
                key={s}
                className={`rounded-md p-3 ${
                  isActive ? "bg-stone-100" : "bg-stone-50/50"
                }`}
              >
                <div className="text-xs font-medium uppercase tracking-wider text-stone-500">
                  {s}
                </div>
                {p ? (
                  <>
                    <div className="font-mono text-lg font-semibold text-stone-900">
                      {monthsLabel(p.months_to_zero)}
                    </div>
                    <div className="text-xs text-stone-500">
                      {fmt.amount(p.total_interest, { cents: true })} interest
                    </div>
                  </>
                ) : (
                  <span className="text-xs text-stone-400">…</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Projection chart */}
      {activePlan && activePlan.months_to_zero > 0 && (
        <section className="mb-6 rounded-lg border border-stone-200 bg-white p-5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-stone-600">
            Projection · {STRATEGY_LABELS[strategy]}
          </h2>
          <ProjectionChart plan={activePlan} fmt={fmt} />
        </section>
      )}

      {/* Per-card terms */}
      <section className="rounded-lg border border-stone-200 bg-white">
        <h2 className="border-b border-stone-100 px-5 py-3 text-sm font-semibold uppercase tracking-wider text-stone-600">
          Cards
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50 text-xs uppercase tracking-wider text-stone-500">
              <th className="px-4 py-2 text-left font-medium">Card</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
              <th className="px-4 py-2 text-right font-medium">APR</th>
              <th className="px-4 py-2 text-right font-medium">Min/mo</th>
              <th className="px-4 py-2 text-left font-medium">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {debt.accounts.map((a, i) => (
              <tr key={a.account_id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-3 w-3 rounded-sm ${
                        PALETTE[i % PALETTE.length]
                      }`}
                    />
                    <span className="font-medium text-stone-900">
                      {a.display_name}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-rose-700">
                  {fmt.amount(a.balance, { cents: true })}
                </td>
                <td className="px-4 py-3 text-right">
                  <AprEditor
                    valuePct={a.apr != null ? a.apr * 100 : null}
                    saving={savingId === a.account_id}
                    onSave={(v) => updateApr(a.account_id, v)}
                  />
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-stone-600">
                  {fmt.amount(
                    Math.max(
                      a.min_payment_floor ?? 25,
                      a.balance * (a.min_payment_pct ?? 0.02),
                    ),
                    { cents: true },
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-stone-500">
                  {a.notes ?? <span className="text-stone-300">—</span>}
                  {a.promo_balance != null &&
                    a.promo_balance > 0 &&
                    a.promo_expires_at && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        ⚠ {fmt.amount(a.promo_balance, { cents: true })} promo at{" "}
                        {((a.promo_apr ?? 0) * 100).toFixed(2)}% expires{" "}
                        {a.promo_expires_at}
                      </div>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function AprEditor({
  valuePct,
  saving,
  onSave,
}: {
  valuePct: number | null;
  saving: boolean;
  onSave: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(valuePct ?? ""));
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="number"
          step="0.01"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSave(Number(value));
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => {
            if (value !== String(valuePct ?? "")) onSave(Number(value));
            setEditing(false);
          }}
          className="w-16 rounded border border-stone-300 px-1 py-0.5 text-right font-mono text-sm"
        />
        <span className="text-stone-400">%</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setValue(String(valuePct ?? ""));
        setEditing(true);
      }}
      className={`font-mono tabular-nums ${
        valuePct != null ? "text-stone-900 hover:text-violet-700" : "text-stone-400 hover:text-violet-700"
      }`}
      title={valuePct != null ? "Click to edit APR" : "Click to set APR"}
      disabled={saving}
    >
      {valuePct != null ? `${valuePct.toFixed(2)}%` : "set APR"}
    </button>
  );
}

function ProjectionChart({
  plan,
  fmt,
}: {
  plan: DebtPlanResponse;
  fmt: ReturnType<typeof usePrivateFormat>;
}) {
  const { months, byAccount, max } = useMemo(() => {
    const months = plan.months_to_zero + 1;
    const byAccount = plan.accounts.map((a) => ({
      id: a.account_id,
      label: a.display_name,
      paidOff: a.paid_off_month,
      points: a.series.slice(0, months + 1),
    }));
    const max = Math.max(
      ...byAccount.flatMap((a) => a.points.map((p) => p.balance)),
    );
    return { months, byAccount, max };
  }, [plan]);

  const W = 720;
  const H = 240;
  const PAD = { l: 50, r: 16, t: 12, b: 30 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const x = (m: number) => PAD.l + (m / Math.max(1, months)) * innerW;
  const y = (v: number) => PAD.t + innerH - (v / Math.max(1, max)) * innerH;

  return (
    <div>
      <svg width={W} height={H} className="block">
        {/* Y-axis gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const yy = PAD.t + innerH * (1 - f);
          return (
            <g key={f}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={yy}
                y2={yy}
                stroke="#e7e5e4"
                strokeDasharray="3 3"
              />
              <text
                x={PAD.l - 6}
                y={yy + 3}
                textAnchor="end"
                className="fill-stone-400 text-[9px]"
              >
                {fmt.amount(max * f)}
              </text>
            </g>
          );
        })}
        {/* X-axis ticks every ~12 months */}
        {Array.from({ length: Math.floor(months / 12) + 1 }, (_, i) => i * 12).map((m) => (
          <text
            key={m}
            x={x(m)}
            y={H - PAD.b + 12}
            textAnchor="middle"
            className="fill-stone-400 text-[9px]"
          >
            {m}m
          </text>
        ))}
        {/* Per-account lines */}
        {byAccount.map((a, i) => {
          const color = ["#e11d48", "#f59e0b", "#10b981", "#0ea5e9", "#8b5cf6", "#78716c"][
            i % 6
          ];
          const d = a.points
            .map((p, j) =>
              `${j === 0 ? "M" : "L"} ${x(p.month)} ${y(p.balance)}`,
            )
            .join(" ");
          return (
            <g key={a.id}>
              <path d={d} fill="none" stroke={color} strokeWidth={2} />
              {a.paidOff != null && (
                <circle cx={x(a.paidOff)} cy={y(0)} r={3} fill={color} />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {byAccount.map((a, i) => (
          <div key={a.id} className="flex items-center gap-1.5 text-stone-600">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{
                backgroundColor: ["#e11d48", "#f59e0b", "#10b981", "#0ea5e9", "#8b5cf6", "#78716c"][i % 6],
              }}
            />
            <span>{a.label}</span>
            {a.paidOff != null && (
              <span className="text-stone-400">· paid off {monthsLabel(a.paidOff)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CashflowPanel({
  cashflow,
  fmt,
  onApplyAvailable,
}: {
  cashflow: NonNullable<CashflowResponse>;
  fmt: ReturnType<typeof usePrivateFormat>;
  onApplyAvailable: () => void;
}) {
  const { enabled: privacyOn } = usePrivacy();
  const [income, setIncome] = useState(
    String(cashflow.user_monthly_income ?? Math.round(cashflow.detected_monthly_income)),
  );
  const [required, setRequired] = useState(
    String(cashflow.user_monthly_required ?? Math.round(cashflow.detected_monthly_required)),
  );
  const [freq, setFreq] = useState(cashflow.pay_frequency);
  const patchCashflow = usePatchCashflow();
  const saving = patchCashflow.isPending;

  const save = () =>
    patchCashflow.mutate({
      monthly_income: income === "" ? null : Number(income),
      monthly_required_expense: required === "" ? null : Number(required),
      pay_frequency: freq,
    });

  return (
    <section className="mb-6 rounded-lg border border-stone-200 bg-white p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
          Monthly cashflow
        </h2>
        <span className="text-xs text-stone-400">
          Edit to override · detected from last 90 days
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <CashflowInput
          label="Income"
          value={income}
          onChange={setIncome}
          onBlur={save}
          detected={cashflow.detected_monthly_income}
          fmt={fmt}
          colorClass="text-emerald-700"
        />
        <CashflowInput
          label="Required expenses"
          value={required}
          onChange={setRequired}
          onBlur={save}
          detected={cashflow.detected_monthly_required}
          fmt={fmt}
          colorClass="text-stone-700"
        />
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-stone-500">
            Debt minimums
          </label>
          <div className="font-mono text-xl font-semibold tabular-nums text-stone-700">
            {fmt.amount(cashflow.monthly_minimums, { cents: true })}
          </div>
          <div className="text-xs text-stone-400">from card terms</div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-stone-500">
            Available for extra debt
          </label>
          <div
            className={`font-mono text-xl font-semibold tabular-nums ${
              cashflow.available_for_debt > 0 ? "text-emerald-700" : "text-rose-700"
            }`}
          >
            {fmt.amount(cashflow.available_for_debt, { cents: true })}
          </div>
          <button
            type="button"
            onClick={onApplyAvailable}
            className="mt-1 text-xs text-violet-600 hover:underline"
          >
            apply to plan ↓
          </button>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3 border-t border-stone-100 pt-3 text-xs text-stone-500">
        <span>Pay frequency:</span>
        <select
          value={freq}
          onChange={(e) => {
            setFreq(e.target.value);
            patchCashflow.mutate({ pay_frequency: e.target.value });
          }}
          className="rounded border border-stone-300 px-2 py-0.5 text-xs"
        >
          <option value="monthly">monthly</option>
          <option value="semimonthly">semi-monthly (15th &amp; 30th)</option>
          <option value="biweekly">biweekly (every 14 days)</option>
          <option value="weekly">weekly</option>
        </select>
        {saving && <span className="text-stone-400">saving…</span>}
      </div>
      {(cashflow.required_breakdown.length > 0 || cashflow.income_breakdown.length > 0) && (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-xs text-stone-500 hover:text-stone-700">
            cashflow breakdown (last 90 days, scaled monthly)
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {cashflow.income_breakdown.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-stone-500">
                  Income sources
                </div>
                <LabeledDonut
                  slices={(() => {
                    const raw = cashflow.income_breakdown.map((r, i) => ({
                      label: shortenSource(r.source),
                      value: r.monthly_avg,
                      color: REQUIRED_PALETTE[i % REQUIRED_PALETTE.length],
                    }));
                    return privacyOn ? privacyLabeledSlices(raw, "debt_income") : raw;
                  })()}
                  size={180}
                  thickness={32}
                  width={460}
                  centerLabel="income"
                  centerValue={fmt.amount(
                    cashflow.income_breakdown.reduce((s, r) => s + r.monthly_avg, 0),
                  )}
                  formatValue={(n) => fmt.amount(n, { cents: true })}
                />
                <p className="mt-2 text-[10px] text-stone-400">
                  detected from positive transactions, excluding internal
                  transfers and credit-card payments. Recurring paychecks
                  with varied payee names may appear as separate entries.
                </p>
              </div>
            )}
            {cashflow.required_breakdown.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-stone-500">
                  Required expenses
                </div>
                <LabeledDonut
                  slices={(() => {
                    const raw = cashflow.required_breakdown.map((r, i) => ({
                      label: formatCategory(r.category),
                      value: r.monthly_avg,
                      color: REQUIRED_PALETTE[i % REQUIRED_PALETTE.length],
                    }));
                    return privacyOn ? privacyLabeledSlices(raw, "debt_required") : raw;
                  })()}
                  size={180}
                  thickness={32}
                  width={460}
                  centerLabel="required"
                  centerValue={fmt.amount(
                    cashflow.required_breakdown.reduce((s, r) => s + r.monthly_avg, 0),
                  )}
                  formatValue={(n) => fmt.amount(n, { cents: true })}
                />
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

function CashflowInput({
  label,
  value,
  onChange,
  onBlur,
  detected,
  fmt,
  colorClass,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  detected: number;
  fmt: ReturnType<typeof usePrivateFormat>;
  colorClass: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-stone-500">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <span className="text-stone-400">$</span>
        <input
          type="number"
          step="50"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={`w-28 rounded border border-stone-300 px-2 py-1 font-mono text-xl font-semibold tabular-nums ${colorClass} outline-none focus:border-violet-400`}
        />
      </div>
      <div className="text-xs text-stone-400">
        detected: {fmt.amount(detected, { cents: true })}/mo
      </div>
    </div>
  );
}

function shortenSource(source: string): string {
  let s = source.trim();
  // Strip trailing IDs like "PPD ID: 12345..." and "WEB ID: ..."
  s = s.replace(/\s*(PPD ID|WEB ID|CO ID|ID#?)[:#].*$/i, "");
  // Strip patterns like "JO SOLUTIONS INC PAYROLL PPD ID: 9117571"
  if (s.length > 28) s = s.slice(0, 25) + "…";
  return s;
}

function monthsLabel(months: number): string {
  if (months <= 0) return "—";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} mo`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}m`;
}

