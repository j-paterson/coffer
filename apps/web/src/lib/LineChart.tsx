// Hand-rolled SVG line chart. Zero dependencies.
//
// Renders one or more line series sharing a single y-axis. Features:
//   - Catmull-Rom smoothing
//   - Hover guide showing every series' value at the hovered x
//   - Click-and-drag range selection with absolute + percent change
//     callout. Click without dragging clears the selection.
//   - Optional area fill per series (line→bottom OR line→zero)
//   - Auto-rendered y=0 baseline when 0 is inside the value range

import { useRef, useState } from "react";
import { ScrubberTooltip } from "./ScrubberTooltip";

export interface Point {
  x: string; // ISO date (display label)
  y: number;
  /** Optional inclusive calendar span the x represents. Used for chart
   *  buckets wider than a day (monthly, weekly, yearly) so drag-range
   *  callbacks can report the full bucket span instead of the mid-bucket
   *  label date. Falls back to `x` when absent. */
  xStart?: string;
  xEnd?: string;
}

export interface Series {
  key: string;
  label: string;
  points: Point[];
  /** Tailwind text-color class — used for the line and (by default) the area. */
  colorClass: string;
  /** Optional override for the area fill color. Falls back to colorClass. */
  areaColorClass?: string;
  /** Area mode:
   *    "bottom" → area between line and chart bottom (default for net-worth view)
   *    "zero"   → area between line and y=0
   *    "none"   → no area, line only */
  areaBaseline?: "bottom" | "zero" | "none";
  /** If set, the area for this series is drawn between this series' line
   *  and the named series' line (instead of using areaBaseline). Useful for
   *  stacked-style "debt sits between assets and net worth" rendering. */
  areaBetween?: string;
  /** If true, the series is included in hover/range tooltips but not
   *  rendered visually (no line, no area, no dots, not in y-range). */
  hidden?: boolean;
  /** Marks this series as a running total (cumulative P&L, etc.) where
   *  each point's y = sum of events through and including that bucket.
   *  For range deltas this flips the math from `y[end] − y[start]` to
   *  `y[end] − y[start − 1]` (= 0 when start is the first bucket) so the
   *  delta includes events in the start bucket — matching what an
   *  inclusive `date >= startDate` filter produces downstream. */
  cumulative?: boolean;
}

interface LineChartProps {
  series: Series[];
  width?: number;
  height?: number;
  formatY?: (n: number) => string;
  onRangeSelect?: (range: { startDate: string; endDate: string } | null) => void;
  /** Reports the hovered point index (or null on leave) so a parent can
   *  render its own header readout instead of the in-chart tooltip. */
  onHoverIndexChange?: (i: number | null) => void;
  /** Render the floating value tooltip. Set false when the parent shows a
   *  header readout instead (the vertical guide line still draws). */
  showTooltip?: boolean;
}

export function LineChart({
  series,
  width = 720,
  height = 240,
  formatY = (n) => n.toLocaleString("en-US"),
  onRangeSelect,
  onHoverIndexChange,
  showTooltip = true,
}: LineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(
    null,
  );

  // All series should share the same x-axis (same length / dates). Use the
  // first non-hidden series as the canonical x ruler.
  const visibleSeries = series.filter((s) => !s.hidden);
  const primary = visibleSeries[0] ?? series[0];
  if (!primary || primary.points.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-stone-200 bg-white text-sm text-stone-400"
        style={{ width: "100%", maxWidth: width, height }}
      >
        no data
      </div>
    );
  }
  const len = primary.points.length;

  const padding = { top: 28, right: 16, bottom: 32, left: 64 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  // Y scale spans every visible series, with 8% padding.
  const allYs = visibleSeries.flatMap((s) => s.points.map((p) => p.y));
  const yMinRaw = Math.min(...allYs);
  const yMaxRaw = Math.max(...allYs);
  const yPad = (yMaxRaw - yMinRaw) * 0.08 || Math.abs(yMaxRaw) * 0.05 || 1;
  const yLo = yMinRaw - yPad;
  const yHi = yMaxRaw + yPad;
  const showZeroLine = yLo < 0 && yHi > 0;

  function xFor(i: number) {
    if (len === 1) return padding.left + innerW / 2;
    return padding.left + (i / (len - 1)) * innerW;
  }
  function yFor(value: number) {
    return padding.top + ((yHi - value) / (yHi - yLo)) * innerH;
  }
  const yZero = yFor(0);
  const yBottom = padding.top + innerH;

  function indexFromX(svgX: number): number {
    if (len === 1) return 0;
    const t = (svgX - padding.left) / innerW;
    const i = Math.round(t * (len - 1));
    return Math.max(0, Math.min(len - 1, i));
  }

  function svgPointFromEvent(e: React.MouseEvent<SVGElement>): { x: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x };
  }

  function handleMouseDown(e: React.MouseEvent<SVGElement>) {
    const p = svgPointFromEvent(e);
    if (!p) return;
    const i = indexFromX(p.x);
    setDrag({ start: i, end: i });
    setSelection(null);
  }
  function handleMouseMove(e: React.MouseEvent<SVGElement>) {
    const p = svgPointFromEvent(e);
    if (!p) return;
    const i = indexFromX(p.x);
    setHoverX(i);
    onHoverIndexChange?.(i);
    if (drag) setDrag({ ...drag, end: i });
  }
  function handleMouseUp(e: React.MouseEvent<SVGElement>) {
    if (!drag) return;
    const p = svgPointFromEvent(e);
    if (!p) {
      setDrag(null);
      return;
    }
    const i = indexFromX(p.x);
    const final = { ...drag, end: i };
    if (final.start === final.end) {
      setSelection(null);
      onRangeSelect?.(null);
    } else {
      const sel = {
        start: Math.min(final.start, final.end),
        end: Math.max(final.start, final.end),
      };
      setSelection(sel);
      // Use bucket spans when a point supplies them (monthly/weekly/
      // yearly charts) so downstream filters pick up the full calendar
      // span the chart was summing — not just the mid-bucket label date.
      const startPt = primary.points[sel.start];
      const endPt = primary.points[sel.end];
      const startDate = startPt?.xStart ?? startPt?.x;
      const endDate = endPt?.xEnd ?? endPt?.x;
      if (startDate && endDate) {
        onRangeSelect?.({ startDate, endDate });
      }
    }
    setDrag(null);
  }
  function handleMouseLeave() {
    setHoverX(null);
    onHoverIndexChange?.(null);
    setDrag(null);
  }

  // Catmull-Rom → cubic Bezier smoothing.
  // `withMove` controls whether the path starts with M (true) or L (false).
  // Reverse mode walks the points end → start so the closed area path can
  // appear in two halves: forward across one line, reversed across the other.
  function smoothPath(s: Series, opts?: { reverse?: boolean; withMove?: boolean }): string {
    const reverse = opts?.reverse ?? false;
    const withMove = opts?.withMove ?? true;
    const ptsRaw = s.points;
    if (ptsRaw.length === 0) return "";
    const xyForward = ptsRaw.map((p, i) => [xFor(i), yFor(p.y)] as const);
    const xy = reverse ? [...xyForward].reverse() : xyForward;
    if (xy.length === 1) {
      return `${withMove ? "M" : "L"} ${xy[0][0]} ${xy[0][1]}`;
    }
    const tension = 6;
    const segs: string[] = [`${withMove ? "M" : "L"} ${xy[0][0]} ${xy[0][1]}`];
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] ?? xy[i];
      const p1 = xy[i];
      const p2 = xy[i + 1];
      const p3 = xy[i + 2] ?? xy[i + 1];
      const c1x = p1[0] + (p2[0] - p0[0]) / tension;
      const c1y = p1[1] + (p2[1] - p0[1]) / tension;
      const c2x = p2[0] - (p3[0] - p1[0]) / tension;
      const c2y = p2[1] - (p3[1] - p1[1]) / tension;
      segs.push(`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`);
    }
    return segs.join(" ");
  }

  function areaPath(s: Series): string | null {
    if (s.areaBetween) {
      const other = visibleSeries.find((o) => o.key === s.areaBetween);
      if (!other) return null;
      // Closed band: smooth line of s forward, then smooth line of `other` reversed.
      return `${smoothPath(s)} ${smoothPath(other, { reverse: true, withMove: false })} Z`;
    }
    const baseline = s.areaBaseline ?? "bottom";
    if (baseline === "none") return null;
    const baseY = baseline === "zero" ? yZero : yBottom;
    const line = smoothPath(s);
    const last = s.points.length - 1;
    return `${line} L ${xFor(last)} ${baseY} L ${xFor(0)} ${baseY} Z`;
  }

  // Active range (drag-in-progress OR finalized)
  const range = drag
    ? {
        start: Math.min(drag.start, drag.end),
        end: Math.max(drag.start, drag.end),
      }
    : selection;
  const rangeValid = range && range.end > range.start;

  // Per-series range deltas. Hidden series (e.g. the per-bucket "Period P&L"
  // overlay on the realized-P&L chart) are excluded: a point-to-point ratio
  // of one bucket's value vs another bucket's value isn't a meaningful
  // summary of the dragged window, just a confusing number.
  const rangeDeltas =
    rangeValid && range
      ? series
          .filter((s) => !s.hidden)
          .map((s) => {
            // For cumulative series, subtract the cumulative *before* the
            // start bucket so the delta includes events that happened on
            // the start date itself. See Series.cumulative docs.
            const sp = s.cumulative
              ? (range.start > 0 ? s.points[range.start - 1]?.y ?? 0 : 0)
              : s.points[range.start]?.y ?? 0;
            const ep = s.points[range.end]?.y ?? 0;
            const abs = ep - sp;
            const pct = sp !== 0 ? (abs / Math.abs(sp)) * 100 : 0;
            return { series: s, abs, pct };
          })
      : null;

  return (
    <svg
      ref={svgRef}
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{
        userSelect: "none",
        cursor: drag ? "ew-resize" : "crosshair",
        maxWidth: width,
        display: "block",
      }}
    >
      {/* Grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const y = padding.top + t * innerH;
        const value = yHi - t * (yHi - yLo);
        return (
          <g key={i}>
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={y}
              y2={y}
              stroke="#e7e5e4"
              strokeDasharray={i === 4 ? "" : "2 4"}
            />
            <text
              x={padding.left - 8}
              y={y + 4}
              textAnchor="end"
              className="fill-stone-400 text-[10px] tabular-nums"
            >
              {formatY(value)}
            </text>
          </g>
        );
      })}

      {/* Zero line, if 0 is inside the value range */}
      {showZeroLine && (
        <line
          x1={padding.left}
          x2={padding.left + innerW}
          y1={yZero}
          y2={yZero}
          stroke="#78716c" /* stone-500 */
          strokeWidth={1}
        />
      )}

      {/* Selection region (under everything) */}
      {rangeValid && range && (
        <rect
          x={xFor(range.start)}
          y={padding.top}
          width={xFor(range.end) - xFor(range.start)}
          height={innerH}
          fill="#0c0a09"
          opacity={0.06}
        />
      )}

      {/* X-axis labels */}
      {primary.points.map((p, i) => {
        const isFirst = i === 0;
        const isLast = i === len - 1;
        const isMid = len > 2 && i === Math.floor((len - 1) / 2);
        if (!(isFirst || isLast || isMid)) return null;
        return (
          <text
            key={i}
            x={xFor(i)}
            y={height - 12}
            textAnchor={isFirst ? "start" : isLast ? "end" : "middle"}
            className="fill-stone-400 text-[10px]"
          >
            {p.x}
          </text>
        );
      })}

      {/* Series areas + lines (visible only) */}
      {visibleSeries.map((s) => {
        const ap = areaPath(s);
        return (
          <g key={s.key}>
            {ap && (
              <path
                d={ap}
                className={s.areaColorClass ?? s.colorClass}
                fill="currentColor"
                opacity={0.12}
              />
            )}
            <path
              d={smoothPath(s)}
              className={s.colorClass}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ pointerEvents: "none" }}
            />
            {s.points.map((p, i) => (
              <circle
                key={i}
                cx={xFor(i)}
                cy={yFor(p.y)}
                r={hoverX === i ? 4.5 : 2.5}
                className={s.colorClass}
                fill="currentColor"
                stroke="white"
                strokeWidth={1.5}
                style={{ pointerEvents: "none" }}
              />
            ))}
          </g>
        );
      })}

      {/* Range endpoint guides */}
      {rangeValid && range && (
        <>
          <line
            x1={xFor(range.start)}
            x2={xFor(range.start)}
            y1={padding.top}
            y2={padding.top + innerH}
            stroke="#1c1917"
            strokeWidth={1}
          />
          <line
            x1={xFor(range.end)}
            x2={xFor(range.end)}
            y1={padding.top}
            y2={padding.top + innerH}
            stroke="#1c1917"
            strokeWidth={1}
          />
        </>
      )}

      {/* Range callout — one row per series. Shows the dollar delta
          (end − start, via formatY) as the primary number, with the
          percent change as a muted secondary. Dollar delta is what lines
          up with external totals like the top-trades sum; percent is
          kept for relative-size context. */}
      {rangeDeltas && rangeDeltas.length > 0 && range && (
        (() => {
          const midX = (xFor(range.start) + xFor(range.end)) / 2;
          const rowH = 18;
          const padX = 10;
          const w = 200;
          const h = rangeDeltas.length * rowH + 10;
          const left = Math.max(
            padding.left,
            Math.min(midX - w / 2, padding.left + innerW - w),
          );
          return (
            <g transform={`translate(${left}, 2)`}>
              <rect width={w} height={h} rx={4} fill="#1c1917" />
              {rangeDeltas.map((d, i) => {
                const positive = d.abs >= 0;
                const sign = positive ? "+" : "";
                const colorFill = positive ? "#34d399" : "#fb7185"; // emerald-400 / rose-400
                return (
                  <g key={d.series.key} transform={`translate(${padX}, ${5 + i * rowH})`}>
                    <text
                      x={0}
                      y={12}
                      className="fill-white text-[11px] font-medium"
                    >
                      {d.series.label}
                    </text>
                    <text
                      x={w - padX * 2}
                      y={12}
                      textAnchor="end"
                      className="text-[11px] font-semibold tabular-nums"
                    >
                      <tspan style={{ fill: colorFill }}>
                        {sign}
                        {formatY(d.abs)}
                      </tspan>
                      <tspan className="fill-white/50" dx={4}>
                        ({sign}
                        {d.pct.toFixed(1)}%)
                      </tspan>
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })()
      )}

      {/* Hover guide. Tooltip layout matches StackedSnapshotChart: a date
          header line on top, then one row per series. */}
      {!drag && hoverX != null && (
        <>
          <line
            x1={xFor(hoverX)}
            x2={xFor(hoverX)}
            y1={padding.top}
            y2={padding.top + innerH}
            stroke="#a8a29e"
            strokeDasharray="2 3"
            style={{ pointerEvents: "none" }}
          />
          {showTooltip && (
            <ScrubberTooltip
              cx={xFor(hoverX)}
              top={padding.top + 6}
              boundsLeft={padding.left}
              boundsRight={padding.left + innerW}
              date={series[0]?.points[hoverX]?.x ?? ""}
              rows={series.map((s) => ({
                label: s.label,
                value: formatY(s.points[hoverX]?.y ?? 0),
              }))}
            />
          )}
        </>
      )}
    </svg>
  );
}
