import { useMemo } from "react";
import type { Timeline } from "../../../../../packages/shared/types";
import { LineChart, type Series } from "../../lib/LineChart";
import { usePrivacy, usePrivateFormat, privacyPoints } from "../../lib/privacy";

export function DeltaChart({
  timeline,
  comparison,
  startDate,
}: {
  timeline: Timeline;
  comparison?: Timeline;
  startDate: string;
}) {
  const { enabled: privacyOn } = usePrivacy();
  const fmt = usePrivateFormat();
  const series = useMemo<Series[]>(() => {
    if (!comparison) return [];
    const startYear = new Date(startDate).getUTCFullYear();
    const points: { x: string; y: number }[] = [];
    for (let i = 11; i < timeline.months.length; i += 12) {
      const delta = timeline.months[i].netWorth - (comparison.months[i]?.netWorth ?? 0);
      points.push({ x: String(startYear + points.length + 1), y: delta });
    }
    return [
      {
        key: "delta",
        label: "Δ vs baseline",
        colorClass: "text-stone-900",
        areaBaseline: "zero",
        points: privacyOn ? privacyPoints(points, "proj_delta") : points,
      },
    ];
  }, [timeline, comparison, startDate, privacyOn]);

  if (!comparison) return null;

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-2 text-sm font-semibold text-stone-900">Δ vs baseline</div>
      <LineChart series={series} width={720} height={180} formatY={(n) => fmt.amount(n)} />
    </div>
  );
}
