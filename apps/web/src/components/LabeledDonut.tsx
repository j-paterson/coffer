import { useState } from "react";

export interface LabeledSlice {
  label: string;
  value: number;
  /** Hex color (not Tailwind class — this component draws SVG primitives). */
  color: string;
}

interface Props {
  slices: LabeledSlice[];
  size?: number;
  thickness?: number;
  width?: number;
  centerLabel?: string;
  centerValue?: string;
  formatValue?: (n: number) => string;
  /** When set, that slice reads as selected (full opacity, stroke). */
  activeIndex?: number | null;
  /** When provided, slices become clickable and fire this with the index. */
  onSliceClick?: (index: number) => void;
}

/**
 * Donut chart with leader lines connecting each slice to a labeled list
 * on the right. Hovering a slice highlights the matching list row, and
 * vice versa, with the leader line emphasizing the link.
 */
export function LabeledDonut({
  slices,
  size = 200,
  thickness = 36,
  width = 480,
  centerLabel,
  centerValue,
  formatValue,
  activeIndex = null,
  onSliceClick,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total === 0) {
    return (
      <div className="text-xs text-stone-400">no data</div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 4;
  const innerRadius = radius - thickness;

  // Build slice arcs + leader endpoints.
  let cursor = -Math.PI / 2;
  const items = slices.map((slice, i) => {
    const value = Math.max(0, slice.value);
    const angle = (value / total) * Math.PI * 2;
    const start = cursor;
    const end = cursor + angle;
    cursor = end;

    const x1 = cx + radius * Math.cos(start);
    const y1 = cy + radius * Math.sin(start);
    const x2 = cx + radius * Math.cos(end);
    const y2 = cy + radius * Math.sin(end);
    const xi1 = cx + innerRadius * Math.cos(end);
    const yi1 = cy + innerRadius * Math.sin(end);
    const xi2 = cx + innerRadius * Math.cos(start);
    const yi2 = cy + innerRadius * Math.sin(start);
    const largeArc = angle > Math.PI ? 1 : 0;

    const arcPath =
      slices.length === 1
        ? // full ring
          [
            `M ${cx + radius} ${cy}`,
            `A ${radius} ${radius} 0 1 1 ${cx - radius} ${cy}`,
            `A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy}`,
            `M ${cx + innerRadius} ${cy}`,
            `A ${innerRadius} ${innerRadius} 0 1 0 ${cx - innerRadius} ${cy}`,
            `A ${innerRadius} ${innerRadius} 0 1 0 ${cx + innerRadius} ${cy}`,
            `Z`,
          ].join(" ")
        : [
            `M ${x1} ${y1}`,
            `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
            `L ${xi1} ${yi1}`,
            `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${xi2} ${yi2}`,
            `Z`,
          ].join(" ");

    const midAngle = (start + end) / 2;
    const exitX = cx + radius * Math.cos(midAngle);
    const exitY = cy + radius * Math.sin(midAngle);
    const bendX = cx + (radius + 16) * Math.cos(midAngle);
    const bendY = cy + (radius + 16) * Math.sin(midAngle);

    return {
      slice,
      i,
      arcPath,
      pct: (value / total) * 100,
      midAngle,
      exitX,
      exitY,
      bendX,
      bendY,
    };
  });

  // Layout list rows on the right.
  const labelStartX = size + 14;
  const rowHeight = 22;
  const totalLabelHeight = items.length * rowHeight;
  const firstRowY = cy - totalLabelHeight / 2 + rowHeight / 2;
  const labelEndX = width - 4;

  return (
    <svg width={width} height={Math.max(size, totalLabelHeight + 8)} viewBox={`0 0 ${width} ${Math.max(size, totalLabelHeight + 8)}`}>
      {/* Slices */}
      {items.map((item) => {
        const isHovered = hover === item.i;
        const isActive = activeIndex === item.i;
        const anySelection = activeIndex != null;
        // Hover overrides selection for the dim-others effect; if nothing
        // is hovered, use the selection to dim non-selected slices.
        const opacity =
          hover != null
            ? isHovered
              ? 1
              : 0.3
            : anySelection
              ? isActive
                ? 1
                : 0.25
              : 1;
        return (
          <path
            key={`slice-${item.i}`}
            d={item.arcPath}
            fill={item.slice.color}
            opacity={opacity}
            stroke={isActive ? "#1c1917" : undefined}
            strokeWidth={isActive ? 1.5 : 0}
            onMouseEnter={() => setHover(item.i)}
            onMouseLeave={() => setHover(null)}
            onClick={onSliceClick ? () => onSliceClick(item.i) : undefined}
            style={{
              cursor: onSliceClick ? "pointer" : "default",
              transition: "opacity 120ms",
            }}
          />
        );
      })}

      {/* List rows on the right */}
      {items.map((item) => {
        const rowY = firstRowY + item.i * rowHeight;
        const isHovered = hover === item.i;
        const valueStr = formatValue
          ? formatValue(item.slice.value)
          : `$${item.slice.value.toFixed(0)}`;
        return (
          <g
            key={`row-${item.i}`}
            onMouseEnter={() => setHover(item.i)}
            onMouseLeave={() => setHover(null)}
            onClick={onSliceClick ? () => onSliceClick(item.i) : undefined}
            style={{ cursor: onSliceClick ? "pointer" : "default" }}
          >
            <rect
              x={labelStartX - 2}
              y={rowY - rowHeight / 2 + 1}
              width={labelEndX - labelStartX + 4}
              height={rowHeight - 2}
              fill={isHovered ? "#f5f5f4" : "transparent"}
              rx={4}
              style={{ transition: "fill 120ms" }}
            />
            <circle
              cx={labelStartX + 4}
              cy={rowY}
              r={4}
              fill={item.slice.color}
            />
            <text
              x={labelStartX + 14}
              y={rowY + 4}
              className={`text-[11px] font-medium ${
                isHovered ? "fill-stone-900" : "fill-stone-700"
              }`}
            >
              {item.slice.label}
            </text>
            <text
              x={labelEndX - 4}
              y={rowY + 4}
              textAnchor="end"
              className={`font-mono text-[11px] tabular-nums ${
                isHovered ? "fill-stone-900" : "fill-stone-600"
              }`}
            >
              {valueStr}
            </text>
          </g>
        );
      })}

      {/* Center label */}
      {(centerLabel || centerValue) && (
        <g transform={`translate(${cx}, ${cy})`} className="pointer-events-none">
          <text
            textAnchor="middle"
            y={-4}
            className="fill-stone-500 text-[10px] uppercase tracking-wider"
          >
            {hover != null ? items[hover].slice.label : centerLabel}
          </text>
          <text
            textAnchor="middle"
            y={16}
            className="fill-stone-900 font-mono text-base font-semibold tabular-nums"
          >
            {hover != null ? `${items[hover].pct.toFixed(1)}%` : centerValue}
          </text>
        </g>
      )}
    </svg>
  );
}
