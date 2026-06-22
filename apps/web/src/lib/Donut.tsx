// Hand-rolled SVG donut chart. Zero dependencies.
//
// Renders a donut from a list of slices: each slice has a value, a label,
// and a Tailwind text color class (e.g. "text-emerald-500"). Slices are laid
// out in order, no sorting. Hover surfaces a label callout.

import { useState } from "react";

export interface Slice {
  label: string;
  value: number;
  /** Tailwind text-color class. The donut uses currentColor for fill. */
  colorClass: string;
}

interface DonutProps {
  slices: Slice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
  /** Fired with the slice label when the user clicks an arc. */
  onSliceClick?: (label: string) => void;
  /** Label of the currently-selected slice; that slice stays bright while others dim. */
  selected?: string | null;
}

export function Donut({
  slices,
  size = 220,
  thickness = 36,
  centerLabel,
  centerValue,
  onSliceClick,
  selected = null,
}: DonutProps) {
  const [hover, setHover] = useState<number | null>(null);

  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-full border border-stone-200 text-sm text-stone-400"
        style={{ width: size, height: size }}
      >
        no data
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 4;
  const innerRadius = radius - thickness;

  // Build arc paths
  let cursor = -Math.PI / 2; // start at 12 o'clock
  const arcs = slices.map((slice, i) => {
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

    // Edge case: a single slice equal to 100% can't be expressed as one arc
    // because start === end. Render as two half-arcs.
    if (slices.length === 1 || angle >= Math.PI * 2 - 0.0001) {
      const d = [
        `M ${cx + radius} ${cy}`,
        `A ${radius} ${radius} 0 1 1 ${cx - radius} ${cy}`,
        `A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy}`,
        `M ${cx + innerRadius} ${cy}`,
        `A ${innerRadius} ${innerRadius} 0 1 0 ${cx - innerRadius} ${cy}`,
        `A ${innerRadius} ${innerRadius} 0 1 0 ${cx + innerRadius} ${cy}`,
        `Z`,
      ].join(" ");
      return { d, slice, i, pct: 100 };
    }

    const d = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${xi1} ${yi1}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${xi2} ${yi2}`,
      `Z`,
    ].join(" ");
    return { d, slice, i, pct: (value / total) * 100 };
  });

  const hovered = hover != null ? arcs[hover] : null;

  return (
    <div className="relative inline-block" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arcs.map(({ d, slice, i }) => {
          const isSelected = selected != null && slice.label === selected;
          const anySelected = selected != null;
          // hover wins; otherwise selected wins; otherwise full
          const opacity =
            hover != null
              ? hover === i
                ? 1
                : 0.35
              : anySelected
                ? isSelected
                  ? 1
                  : 0.35
                : 1;
          return (
            <path
              key={i}
              d={d}
              className={`${slice.colorClass} transition-opacity`}
              fill="currentColor"
              opacity={opacity}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSliceClick?.(slice.label)}
              style={{ cursor: onSliceClick ? "pointer" : "default" }}
            />
          );
        })}
      </svg>
      {/* Center label — hovered slice or default total */}
      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
      >
        <div className="text-[10px] font-medium uppercase tracking-wider text-stone-500">
          {hovered ? hovered.slice.label : centerLabel}
        </div>
        <div className="font-mono text-xl font-semibold tabular-nums text-stone-900">
          {hovered ? `${hovered.pct.toFixed(1)}%` : centerValue}
        </div>
      </div>
    </div>
  );
}
