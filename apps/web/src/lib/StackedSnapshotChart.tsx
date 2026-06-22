import { useMemo, useState } from "react";
import { formatDate, formatUsd } from "./format";
import { usePrivacy } from "./privacy";

// Cool-spectrum palette for assets (green→teal→cyan→blue→indigo→violet).
// Deliberately avoids the red/orange/yellow range so assets never visually
// clash with the red debt palette mirrored below the baseline.
const PALETTE = [
  "#10b981", // emerald
  "#15803d", // green-700
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#0ea5e9", // sky
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
];
// Dedicated reds for debts, mirrored below the zero baseline so liabilities
// read instantly as "red" and stay distinct from the asset stack above.
const DEBT_PALETTE = [
  "#ef4444", // red
  "#fb923c", // orange
  "#f43f5e", // rose
  "#e11d48", // crimson
  "#fda4af", // light rose
];
const OTHER_COLOR = "#a8a29e"; // stone-400

export type StackedSnapshot = {
  as_of: string;
  /** Net total (assets - debts). Used for the header readout. */
  total: number;
  /** Per-bucket values. Positive = asset, negative = debt. */
  holdings: { symbol: string; value_usd: number }[];
};

type Seg = { symbol: string; value: number; color: string };
type Bar = {
  as_of: string;
  segsPos: Seg[];
  segsNeg: Seg[];
  posSum: number;
  negMag: number;
  total: number;
};

type Props = {
  snapshots: StackedSnapshot[];
  width?: number;
  height?: number;
  /** Cap on colored series PER SIDE (assets and debts each). Overflow is
   * dropped from the chart entirely (no "other" bucket) — the user prefers
   * an itemized view to aggregation. Set Infinity to show all. */
  maxSeries?: number;
  /** Reports the hovered bar index (or null) so a parent can render its own
   *  header readout. */
  onHoverIndexChange?: (i: number | null) => void;
  /** Show the date + assets/debts/net summary atop the legend. Set false
   *  when a parent header already shows it (avoids duplication). */
  showSummary?: boolean;
};

/**
 * Stacked-bars-over-time chart for account/wallet history. Each snapshot
 * becomes one vertical bar, segmented by symbol. Bars are placed edge-to-
 * edge so dense daily series read like a stacked area, while sparse series
 * look like discrete bars.
 *
 * Buckets with negative value_usd (debts) stack DOWNWARD from a zero
 * baseline, mirroring the asset stack above. When no negatives are present
 * the baseline sits at the bottom and the chart behaves like a plain
 * positive stack (Split / per-account / wallet views are unaffected).
 */
export function StackedSnapshotChart({
  snapshots,
  width = 420,
  height = 180,
  maxSeries = 8,
  onHoverIndexChange,
  showSummary = true,
}: Props) {
  const { enabled: privacyOn } = usePrivacy();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { bars, maxPos, maxNeg } = useMemo(() => {
    // Sum each symbol across all snapshots; a symbol's overall sign decides
    // which side of the baseline it lives on for the whole window (so a
    // bucket doesn't hop sides if it briefly crosses zero on one date).
    const totals = new Map<string, number>();
    for (const s of snapshots) {
      for (const h of s.holdings) {
        totals.set(h.symbol, (totals.get(h.symbol) ?? 0) + h.value_usd);
      }
    }
    const entries = [...totals.entries()].filter(([, v]) => Math.abs(v) > 0.005);
    const assetSyms = entries
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxSeries)
      .map(([s]) => s);
    const debtSyms = entries
      .filter(([, v]) => v < 0)
      .sort((a, b) => a[1] - b[1]) // most negative first
      .slice(0, maxSeries)
      .map(([s]) => s);

    const assetSet = new Set(assetSyms);
    const debtSet = new Set(debtSyms);
    const colorOf = (sym: string) => {
      const ai = assetSyms.indexOf(sym);
      if (ai >= 0) return PALETTE[ai % PALETTE.length];
      const di = debtSyms.indexOf(sym);
      if (di >= 0) return DEBT_PALETTE[di % DEBT_PALETTE.length];
      return OTHER_COLOR;
    };

    let maxPos = 0;
    let maxNeg = 0;
    const bars: Bar[] = snapshots.map((s) => {
      const segsPos: Seg[] = [];
      const segsNeg: Seg[] = [];
      let posSum = 0;
      let negMag = 0;
      for (const h of s.holdings) {
        if (Math.abs(h.value_usd) <= 0.005) continue;
        if (assetSet.has(h.symbol)) {
          segsPos.push({ symbol: h.symbol, value: h.value_usd, color: colorOf(h.symbol) });
          posSum += h.value_usd;
        } else if (debtSet.has(h.symbol)) {
          segsNeg.push({ symbol: h.symbol, value: h.value_usd, color: colorOf(h.symbol) });
          negMag += Math.abs(h.value_usd);
        }
      }
      // If a snapshot has no usable breakdown, fall back to its net total as
      // a single neutral asset segment so the bar still renders.
      if (segsPos.length === 0 && segsNeg.length === 0 && s.total > 0) {
        segsPos.push({ symbol: "total", value: s.total, color: OTHER_COLOR });
        posSum = s.total;
      }
      segsPos.sort((a, b) => assetSyms.indexOf(a.symbol) - assetSyms.indexOf(b.symbol));
      segsNeg.sort((a, b) => debtSyms.indexOf(a.symbol) - debtSyms.indexOf(b.symbol));
      if (posSum > maxPos) maxPos = posSum;
      if (negMag > maxNeg) maxNeg = negMag;
      return { as_of: s.as_of, segsPos, segsNeg, posSum, negMag, total: s.total };
    });

    return { bars, maxPos, maxNeg };
  }, [snapshots, maxSeries]);

  if (snapshots.length === 0) return null;

  const PAD = { l: 8, r: 8, t: 14, b: 4 };
  const innerW = width - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const n = bars.length;
  const barW = innerW / Math.max(n, 1);
  const span = Math.max(maxPos + maxNeg, 1);
  const hasDebt = maxNeg > 0.005;
  // Modest empty band around the zero baseline so the asset stack (above)
  // and debt stack (below) read as two separate masses. No gap when there
  // are no debts, keeping positive-only views identical to before.
  const GAP = hasDebt ? 8 : 0;
  const usableH = innerH - GAP;
  const px = usableH / span; // pixels per dollar
  const topBase = PAD.t + maxPos * px; // baseline for assets (stack upward)
  const botBase = topBase + GAP; // baseline for debts (stack downward)
  const zeroY = topBase + GAP / 2; // baseline line, centered in the gap

  const fmtUsd = (v: number) => (privacyOn ? "•••" : formatUsd(v));
  const hovered = hoverIdx != null ? bars[hoverIdx] : null;

  const legendSource = hovered ?? bars[bars.length - 1];

  // Legend mirrors the scrubbed-to date: assets (pct of that date's asset
  // total) then debts (pct of that date's debt total), each non-zero only.
  const assetRows = (legendSource?.segsPos ?? [])
    .filter((s) => s.symbol !== "total" && Math.abs(s.value) > 0.005)
    .map((s) => ({
      symbol: s.symbol,
      color: s.color,
      value: s.value,
      pct: legendSource && legendSource.posSum > 0 ? (s.value / legendSource.posSum) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);
  const debtRows = (legendSource?.segsNeg ?? [])
    .filter((s) => Math.abs(s.value) > 0.005)
    .map((s) => ({
      symbol: s.symbol,
      color: s.color,
      value: s.value,
      pct: legendSource && legendSource.negMag > 0 ? (Math.abs(s.value) / legendSource.negMag) * 100 : 0,
    }))
    .sort((a, b) => a.value - b.value);

  const renderLegendRow = ({
    symbol,
    color,
    value,
    pct,
  }: {
    symbol: string;
    color: string;
    value: number;
    pct: number;
  }) => (
    <li key={symbol} className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-sm"
          style={{ backgroundColor: color }}
        />
        <span className="truncate font-mono text-stone-700">{symbol}</span>
      </span>
      <span className="flex items-baseline gap-1 whitespace-nowrap">
        <span className="tabular-nums text-stone-400">{pct.toFixed(1)}%</span>
        <span className="font-mono tabular-nums text-stone-600">{fmtUsd(value)}</span>
      </span>
    </li>
  );

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ maxWidth: width }}
          className="block"
          onMouseLeave={() => {
            setHoverIdx(null);
            onHoverIndexChange?.(null);
          }}
        >
          {bars.map((b, i) => {
            const x = PAD.l + i * barW;
            const w = Math.max(barW - 0.5, 0.5);
            let accP = 0;
            let accN = 0;
            return (
              <g key={b.as_of}>
                {b.segsPos.map((seg) => {
                  const segY = topBase - (accP + seg.value) * px;
                  const segH = seg.value * px;
                  accP += seg.value;
                  return (
                    <rect
                      key={"p:" + seg.symbol}
                      x={x}
                      y={segY}
                      width={w}
                      height={Math.max(segH, 0)}
                      fill={seg.color}
                      opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.55}
                    />
                  );
                })}
                {b.segsNeg.map((seg) => {
                  const mag = Math.abs(seg.value);
                  const segY = botBase + accN * px;
                  accN += mag;
                  return (
                    <rect
                      key={"n:" + seg.symbol}
                      x={x}
                      y={segY}
                      width={w}
                      height={Math.max(mag * px, 0)}
                      fill={seg.color}
                      opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.55}
                    />
                  );
                })}
              </g>
            );
          })}
          {/* Zero baseline (only when debts pull the chart below zero). */}
          {hasDebt && (
            <line
              x1={PAD.l}
              x2={width - PAD.r}
              y1={zeroY}
              y2={zeroY}
              stroke="#78716c"
              strokeWidth={0.75}
            />
          )}
          {hoverIdx != null && (
            <line
              x1={PAD.l + hoverIdx * barW + barW / 2}
              x2={PAD.l + hoverIdx * barW + barW / 2}
              y1={PAD.t}
              y2={height - PAD.b}
              stroke="#0c0a09"
              strokeDasharray="2 2"
              strokeWidth={0.5}
            />
          )}
          {/* pointer-tracking overlay */}
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="transparent"
            onMouseMove={(e) => {
              const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
              const scale = rect.width > 0 ? width / rect.width : 1;
              const pxX = (e.clientX - rect.left) * scale - PAD.l;
              const idx = Math.floor(pxX / barW);
              if (idx >= 0 && idx < n) {
                setHoverIdx(idx);
                onHoverIndexChange?.(idx);
              }
            }}
          />
        </svg>
      </div>
      {/* Right-side legend. A summary (date + assets / debts / net split)
          sits on top, then per-account rows. Everything updates to the
          scrubbed-to date on hover. */}
      <ul className="w-48 shrink-0 space-y-0.5 text-[11px] text-stone-500">
        {showSummary && (
          <li className="mb-1.5 space-y-0.5 border-b border-stone-200 pb-1.5">
            <div className="text-[10px] text-stone-400">
              {hovered ? formatDate(hovered.as_of) : "latest"}
            </div>
            {hasDebt && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-emerald-600">Assets</span>
                  <span className="font-mono tabular-nums text-stone-700">
                    {fmtUsd(legendSource?.posSum ?? 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-rose-500">Debts</span>
                  <span className="font-mono tabular-nums text-stone-700">
                    {privacyOn ? "•••" : `-${formatUsd(legendSource?.negMag ?? 0)}`}
                  </span>
                </div>
              </>
            )}
            <div className="flex items-center justify-between font-semibold text-stone-800">
              <span>Net worth</span>
              <span className="font-mono tabular-nums">{fmtUsd(legendSource?.total ?? 0)}</span>
            </div>
          </li>
        )}
        {assetRows.map(renderLegendRow)}
        {debtRows.length > 0 && (
          <li className="!mt-1.5 border-t border-stone-200 pt-1 text-[10px] uppercase tracking-wide text-stone-400">
            debts
          </li>
        )}
        {debtRows.map(renderLegendRow)}
      </ul>
    </div>
  );
}
