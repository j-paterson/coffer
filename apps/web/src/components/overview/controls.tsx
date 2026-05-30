/** Segmented-control bits used by the Overview page. */

import type { Granularity } from "../../../../../packages/shared/types";

export type { Granularity };
export type ChartMode = "combined" | "split" | "breakdown";
export type TimeRange = "1m" | "3m" | "6m" | "ytd" | "1y" | "all";

export const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "all", label: "All" },
];

const MODE_OPTIONS: { value: ChartMode; label: string }[] = [
  { value: "combined", label: "Net" },
  { value: "split", label: "Split" },
  { value: "breakdown", label: "Breakdown" },
];

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

export function rangeStart(range: TimeRange): string | null {
  if (range === "all") return null;
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (range === "ytd") return `${today.getFullYear()}-01-01`;
  const d = new Date(today);
  if (range === "1m") d.setMonth(today.getMonth() - 1);
  else if (range === "3m") d.setMonth(today.getMonth() - 3);
  else if (range === "6m") d.setMonth(today.getMonth() - 6);
  else if (range === "1y") d.setFullYear(today.getFullYear() - 1);
  return iso(d);
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "sm",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  size?: "sm" | "xs";
}) {
  const px = size === "xs" ? "px-2.5" : "px-3";
  return (
    <div className="flex rounded-md border border-stone-200 bg-stone-50 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded ${px} py-1 text-xs font-medium transition-colors ${
            value === o.value
              ? "bg-white text-stone-900 shadow-sm"
              : "text-stone-500 hover:text-stone-700"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function RangeSwitch({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (v: TimeRange) => void;
}) {
  return <Segmented value={value} onChange={onChange} options={RANGE_OPTIONS} size="xs" />;
}

export function ModeSwitch({
  value,
  onChange,
}: {
  value: ChartMode;
  onChange: (v: ChartMode) => void;
}) {
  return <Segmented value={value} onChange={onChange} options={MODE_OPTIONS} />;
}

export function GranularitySwitch({
  value,
  onChange,
}: {
  value: Granularity;
  onChange: (v: Granularity) => void;
}) {
  return (
    <Segmented value={value} onChange={onChange} options={GRANULARITY_OPTIONS} />
  );
}

export function ChartPlaceholder({
  height,
  label,
}: {
  height: number;
  label: string;
}) {
  return (
    <div
      className="flex items-center justify-center text-sm text-stone-400"
      style={{ height }}
    >
      {label}
    </div>
  );
}

