import { useMemo, useState } from "react";
import { formatDate, formatUsd } from "./format";
import { usePrivacy } from "./privacy";

// Distinct-by-hue palette (matches ChainBreakdownBar ordering).
const PALETTE = [
  "#10b981", // emerald
  "#f59e0b", // amber
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#f43f5e", // rose
  "#14b8a6", // teal
  "#ec4899", // pink
  "#f97316", // orange
  "#84cc16", // lime
  "#6366f1", // indigo
];
const OTHER_COLOR = "#a8a29e"; // stone-400

export type StackedSnapshot = {
  as_of: string;
  total: number;
  holdings: { symbol: string; value_usd: number }[];
};

type Props = {
  snapshots: StackedSnapshot[];
  width?: number;
  height?: number;
  /** Cap on colored series. Overflow is dropped from the chart entirely
   * (no "other" bucket) — the user prefers itemized view to aggregation,
   * even if some long-tail series don't appear. Set Infinity to show all. */
  maxSeries?: number;
};

/**
 * Stacked-bars-over-time chart for account/wallet history. Each snapshot
 * becomes one vertical bar, segmented by symbol. Bars are placed edge-to-
 * edge so dense daily series read like a stacked area, while sparse series
 * look like discrete bars.
 */
export function StackedSnapshotChart({
  snapshots,
  width = 420,
  height = 180,
  maxSeries = 8,
}: Props) {
  const { enabled: privacyOn } = usePrivacy();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { series, maxTotal } = useMemo(() => {
    // Sum each symbol across all snapshots; drop symbols that contribute
    // zero (or near-zero) total value — those would otherwise appear in
    // the legend with a $0 row.
    const totals = new Map<string, number>();
    for (const s of snapshots) {
      for (const h of s.holdings) {
        totals.set(h.symbol, (totals.get(h.symbol) ?? 0) + h.value_usd);
      }
    }
    // Keep any symbol that has non-zero value somewhere in the window —
    // the legend below filters again per scrubber position so items
    // currently at $0 disappear by default but reappear when scrubbed
    // to a date when they had value.
    const sorted = [...totals.entries()]
      .filter(([, v]) => Math.abs(v) > 0.005)
      .sort((a, b) => b[1] - a[1]);
    // Top-N visible symbols. Anything beyond the cap is dropped (not
    // bucketed) so every legend entry corresponds to a real account.
    const top = sorted.slice(0, maxSeries).map(([sym]) => sym);
    const visible = new Set(top);
    const order = [...top];
    const colorOf = (sym: string) => {
      const idx = top.indexOf(sym);
      return idx >= 0 ? PALETTE[idx % PALETTE.length] : OTHER_COLOR;
    };

    let maxTotal = 0;
    const perSnapshot = snapshots.map((s) => {
      const segs: { symbol: string; value: number; color: string }[] = [];
      let snapTotal = 0;
      for (const h of s.holdings) {
        if (!visible.has(h.symbol)) continue;
        if (Math.abs(h.value_usd) <= 0.005) continue;
        snapTotal += h.value_usd;
        segs.push({
          symbol: h.symbol,
          value: h.value_usd,
          color: colorOf(h.symbol),
        });
      }
      // If snapshot has no breakdown, fall back to total as a single
      // neutral segment so the bar still renders.
      if (segs.length === 0 && s.total > 0) {
        segs.push({ symbol: "total", value: s.total, color: OTHER_COLOR });
        snapTotal = s.total;
      }
      segs.sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol));
      if (snapTotal > maxTotal) maxTotal = snapTotal;
      return { as_of: s.as_of, total: snapTotal || s.total, segs };
    });

    const legend = order.map((sym) => ({ symbol: sym, color: colorOf(sym) }));
    return { series: { bars: perSnapshot, legend }, maxTotal };
  }, [snapshots, maxSeries]);

  if (snapshots.length === 0) return null;

  const PAD = { l: 8, r: 8, t: 14, b: 4 };
  const innerW = width - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const n = series.bars.length;
  const barW = innerW / Math.max(n, 1);
  const y = (v: number) => PAD.t + innerH - (v / Math.max(maxTotal, 1)) * innerH;

  const fmtUsd = (n: number) => (privacyOn ? "•••" : formatUsd(n));
  const hovered = hoverIdx != null ? series.bars[hoverIdx] : null;

  const headerValue = hovered
    ? hovered.total
    : series.bars[series.bars.length - 1]?.total ?? 0;
  const legendSource = hovered ?? series.bars[series.bars.length - 1];
  // Legend mirrors the scrubbed-to date: only show symbols with non-
  // zero value AT that point in time. As the scrubber moves, items
  // appear/disappear with their actual presence on that date.
  const legendRows = [...series.legend]
    .map(({ symbol, color }) => ({
      symbol,
      color,
      value:
        legendSource?.segs.find((s) => s.symbol === symbol)?.value ?? 0,
    }))
    .filter(({ value }) => Math.abs(value) > 0.005)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs leading-tight text-stone-500">
          <div>{hovered ? formatDate(hovered.as_of) : "value over time"}</div>
          <div className="font-mono tabular-nums text-stone-700">
            {fmtUsd(headerValue)}
          </div>
        </div>
      <svg
        width={width}
        height={height}
        className="block"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {series.bars.map((b, i) => {
          const x = PAD.l + i * barW;
          let acc = 0;
          return (
            <g key={b.as_of}>
              {b.segs.map((seg) => {
                const segY = y(acc + seg.value);
                const segH = y(acc) - segY;
                acc += seg.value;
                return (
                  <rect
                    key={seg.symbol}
                    x={x}
                    y={segY}
                    width={Math.max(barW - (n > 80 ? 0 : 0.5), 0.5)}
                    height={Math.max(segH, 0)}
                    fill={seg.color}
                    opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.55}
                  />
                );
              })}
            </g>
          );
        })}
        {hoverIdx != null && (
          <>
            <line
              x1={PAD.l + hoverIdx * barW + barW / 2}
              x2={PAD.l + hoverIdx * barW + barW / 2}
              y1={PAD.t}
              y2={height - PAD.b}
              stroke="#0c0a09"
              strokeDasharray="2 2"
              strokeWidth={0.5}
            />
            {hovered && (() => {
              // Flip the label to the opposite side of the midpoint so it
              // doesn't get cut off near either edge.
              const cx = PAD.l + hoverIdx * barW + barW / 2;
              const right = cx > width / 2;
              const tx = right ? cx - 6 : cx + 6;
              return (
                <g>
                  <rect
                    x={right ? tx - 66 : tx}
                    y={PAD.t}
                    width={66}
                    height={14}
                    fill="white"
                    opacity={0.9}
                  />
                  <text
                    x={tx}
                    y={PAD.t + 10}
                    textAnchor={right ? "end" : "start"}
                    fontSize="10"
                    fill="#44403c"
                    fontFamily="ui-monospace,monospace"
                  >
                    {formatDate(hovered.as_of)}
                  </text>
                </g>
              );
            })()}
          </>
        )}
        {/* pointer-tracking overlay */}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          onMouseMove={(e) => {
            const rect = (
              e.currentTarget as SVGRectElement
            ).getBoundingClientRect();
            const px = e.clientX - rect.left - PAD.l;
            const idx = Math.floor(px / barW);
            if (idx >= 0 && idx < n) setHoverIdx(idx);
          }}
        />
      </svg>
      </div>
      {/* Right-side legend: latest per-asset values by default,
          updates to the scrubbed-to date on hover. */}
      <ul className="w-48 shrink-0 space-y-0.5 text-[11px] text-stone-500">
        {legendRows.map(({ symbol, color, value }) => {
          const pct =
            legendSource && legendSource.total > 0
              ? (value / legendSource.total) * 100
              : 0;
          return (
            <li
              key={symbol}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate font-mono text-stone-700">
                  {symbol}
                </span>
              </span>
              <span className="flex items-baseline gap-1 whitespace-nowrap">
                <span className="tabular-nums text-stone-400">
                  {pct.toFixed(1)}%
                </span>
                <span className="font-mono tabular-nums text-stone-600">
                  {fmtUsd(value)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
