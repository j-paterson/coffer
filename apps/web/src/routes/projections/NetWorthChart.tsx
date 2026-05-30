import { useMemo } from "react";
import type { Timeline } from "../../../../../packages/shared/types";
import { LineChart, type Series } from "../../lib/LineChart";
import { usePrivacy, usePrivateFormat, privacyPoints } from "../../lib/privacy";

type Props = {
  timeline: Timeline;
  comparison?: Timeline;
  showMC: boolean;
  startDate: string;
};

function yearLabels(startDate: string, nYears: number): string[] {
  const base = new Date(startDate);
  const startYear = base.getUTCFullYear();
  return Array.from({ length: nYears }, (_, i) => String(startYear + i + 1));
}

function yearEnd<T>(rows: T[], pick: (r: T) => number): number[] {
  const out: number[] = [];
  for (let i = 11; i < rows.length; i += 12) out.push(pick(rows[i]));
  return out;
}

export function NetWorthChart({ timeline, comparison, showMC, startDate }: Props) {
  const { enabled: privacyOn } = usePrivacy();
  const fmt = usePrivateFormat();
  const series = useMemo<Series[]>(() => {
    const main = yearEnd(timeline.months, (m) => m.netWorth);
    const labels = yearLabels(startDate, main.length);
    const out: Series[] = [
      {
        key: "netWorth",
        label: "Net worth",
        colorClass: "text-stone-900",
        areaBaseline: "bottom",
        points: privacyOn
          ? privacyPoints(main.map((y, i) => ({ x: labels[i], y })), "proj_networth")
          : main.map((y, i) => ({ x: labels[i], y })),
      },
    ];
    if (comparison) {
      const cmp = yearEnd(comparison.months, (m) => m.netWorth);
      out.push({
        key: "baseline",
        label: "No-HELOC baseline",
        colorClass: "text-stone-400",
        areaBaseline: "none",
        points: privacyOn
          ? privacyPoints(cmp.map((y, i) => ({ x: labels[i], y })), "proj_baseline")
          : cmp.map((y, i) => ({ x: labels[i], y })),
      });
    }
    if (showMC && timeline.mc) {
      const p10 = yearEnd(timeline.mc.p10.map((v, i) => ({ v, i })), (r) => r.v);
      const p90 = yearEnd(timeline.mc.p90.map((v, i) => ({ v, i })), (r) => r.v);
      out.push({
        key: "mcP10",
        label: "MC 10th pct",
        colorClass: "text-stone-300",
        areaBaseline: "none",
        points: privacyOn
          ? privacyPoints(p10.map((y, i) => ({ x: labels[i], y })), "proj_mc_p10")
          : p10.map((y, i) => ({ x: labels[i], y })),
      });
      out.push({
        key: "mcP90",
        label: "MC 90th pct",
        colorClass: "text-stone-300",
        areaBaseline: "none",
        points: privacyOn
          ? privacyPoints(p90.map((y, i) => ({ x: labels[i], y })), "proj_mc_p90")
          : p90.map((y, i) => ({ x: labels[i], y })),
      });
    }
    return out;
  }, [timeline, comparison, showMC, startDate, privacyOn]);

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-stone-900">Net worth projection</div>
        <div className="text-xs text-stone-500">year-end values; hover for detail, drag to measure</div>
      </div>
      <LineChart series={series} width={720} height={260} formatY={(n) => fmt.amount(n)} />
    </div>
  );
}
