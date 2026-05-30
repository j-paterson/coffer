import type { ProjectionSummary } from "../../../../../packages/shared/types";

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
function fmtCurrency(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "−";
  const abs = Math.abs(v);
  const unit = abs >= 1_000_000 ? "M" : abs >= 1_000 ? "K" : "";
  const scaled = abs >= 1_000_000 ? abs / 1_000_000 : abs >= 1_000 ? abs / 1_000 : abs;
  return `${sign}$${scaled.toFixed(1)}${unit}`;
}
function fmtMonth(m: number | null | undefined): string {
  if (m == null) return "—";
  const yr = Math.floor(m / 12);
  return `Yr ${yr}`;
}

export function HeadlineCards({ summary }: { summary: ProjectionSummary | undefined }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      <Card label="Break-even return" value={fmtPct(summary?.breakEvenReturnPct ?? null)} caption="annualized, to match do-nothing" />
      <Card label="Δ at horizon" value={fmtCurrency(summary?.deltaVsBaseline)} caption="median path" color={summary && summary.deltaVsBaseline > 0 ? "green" : summary && summary.deltaVsBaseline < 0 ? "red" : undefined} />
      <Card label="MC success" value={summary?.mcSuccessProbability != null ? `${Math.round(summary.mcSuccessProbability * 100)}%` : "—"} caption="paths with Δ > 0" />
      <Card label="First underwater" value={fmtMonth(summary?.firstMonthUnderwaterOnHome)} caption="collateral < debt" color={summary?.firstMonthUnderwaterOnHome != null ? "red" : undefined} />
    </div>
  );
}

function Card({ label, value, caption, color }: { label: string; value: string; caption?: string; color?: "green" | "red" }) {
  const valueColor = color === "green" ? "text-emerald-700" : color === "red" ? "text-red-700" : "text-stone-900";
  return (
    <div className="rounded-md border border-stone-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wider text-stone-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueColor}`}>{value}</div>
      {caption && <div className="text-[10px] text-stone-500">{caption}</div>}
    </div>
  );
}
