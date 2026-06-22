/** Shared hover/scrubber tooltip for time-series charts. A dark rounded box
 *  with a date header and one row per series (label left, value right),
 *  clamped to the chart's drawable bounds. Used by both LineChart (Split
 *  view) and StackedSnapshotChart (Breakdown view) so the two stay identical.
 */

export type TooltipRow = { label: string; value: string };

export function ScrubberTooltip({
  cx,
  top,
  boundsLeft,
  boundsRight,
  date,
  rows,
  width = 152,
}: {
  /** Center x of the scrubber line. The box is centered here, then clamped. */
  cx: number;
  /** Top y of the box. */
  top: number;
  /** Left/right edges of the drawable area used to clamp the box. */
  boundsLeft: number;
  boundsRight: number;
  /** Header text (typically the hovered date). */
  date: string;
  /** One row per series; `value` is pre-formatted. */
  rows: TooltipRow[];
  width?: number;
}) {
  const rowH = 17;
  const headerH = 17;
  const padX = 10;
  const w = width;
  const h = headerH + rows.length * rowH + 8;
  const left = Math.max(boundsLeft, Math.min(cx - w / 2, boundsRight - w));
  return (
    <g transform={`translate(${left}, ${top})`} style={{ pointerEvents: "none" }}>
      <rect width={w} height={h} rx={4} fill="#1c1917" />
      <text x={padX} y={headerH - 4} className="fill-white/70 text-[10px] font-medium">
        {date}
      </text>
      {rows.map((r, i) => (
        <g key={r.label} transform={`translate(${padX}, ${headerH + 4 + i * rowH})`}>
          <text x={0} y={10} className="fill-white text-[11px]">
            {r.label}
          </text>
          <text
            x={w - padX * 2}
            y={10}
            textAnchor="end"
            className="fill-white text-[11px] font-medium tabular-nums"
          >
            {r.value}
          </text>
        </g>
      ))}
    </g>
  );
}
