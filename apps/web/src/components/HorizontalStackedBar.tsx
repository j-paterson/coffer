import { useState } from "react";
import { usePrivateFormat } from "../lib/privacy";

export interface StackedSegment {
  /** Identity used for state (selection, click callbacks). Stored as the
   * canonical category form so it round-trips with the underlying data. */
  label: string;
  /** Optional pretty form rendered to the user. Falls back to label. */
  displayLabel?: string;
  value: number;
  /** Tailwind bg-* class for the segment color. */
  bgClass: string;
  /** Optional sub-label shown in the tooltip. */
  hint?: string;
}

interface Props {
  segments: StackedSegment[];
  height?: number;
  /** Shown above the bar when nothing is hovered. */
  centerLabel?: string;
  /** Label of the currently-selected segment (for highlighting). */
  selected?: string | null;
  /** Fires with the clicked label, or null if the user clicked the already-selected segment (toggle off). */
  onSegmentClick?: (label: string | null) => void;
  /** Fires when the user wants to merge/rename a segment. */
  onSegmentMerge?: (label: string) => void;
}

/**
 * Horizontal stacked bar with hover callouts — used to show a category's
 * subcategory breakdown inside the spending drill-down. Zero dependencies.
 */
export function HorizontalStackedBar({
  segments,
  height = 20,
  centerLabel,
  selected = null,
  onSegmentClick,
  onSegmentMerge,
}: Props) {
  const fmt = usePrivateFormat();
  const [hover, setHover] = useState<number | null>(null);

  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total === 0) {
    return (
      <div className="rounded-md border border-dashed border-stone-200 px-3 py-2 text-xs text-stone-400">
        no subcategory data yet
      </div>
    );
  }

  const hovered = hover != null ? segments[hover] : null;

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-baseline justify-between text-xs text-stone-500">
        <span>
          {hovered
            ? hovered.displayLabel ?? hovered.label
            : centerLabel ?? `${segments.length} subcategories`}
        </span>
        <span className="font-mono tabular-nums">
          {hovered
            ? `${fmt.amount(hovered.value, { cents: true })} · ${((hovered.value / total) * 100).toFixed(1)}%`
            : fmt.amount(total, { cents: true })}
        </span>
      </div>
      <div
        className="flex w-full overflow-hidden rounded-md bg-stone-100"
        style={{ height }}
      >
        {segments.map((seg, i) => {
          const pct = (Math.max(0, seg.value) / total) * 100;
          const isSelected = selected === seg.label;
          const anySelected = selected != null;
          // Opacity rules:
          //   nothing hovered, nothing selected -> full
          //   hovered segment -> full, others dim
          //   any segment selected -> selected full, others dim
          const opacity = hover != null
            ? hover === i
              ? 1
              : 0.35
            : anySelected
              ? isSelected
                ? 1
                : 0.35
              : 1;
          return (
            <div
              key={seg.label + i}
              title={`${seg.displayLabel ?? seg.label} · ${fmt.amount(seg.value, { cents: true })} · ${pct.toFixed(1)}%`}
              className={`${seg.bgClass} transition-opacity`}
              style={{
                width: `${pct}%`,
                opacity,
                cursor: onSegmentClick ? "pointer" : "default",
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                if (!onSegmentClick) return;
                onSegmentClick(isSelected ? null : seg.label);
              }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
        {segments.map((seg) => {
          const isSelected = selected === seg.label;
          return (
            <button
              key={seg.label}
              type="button"
              onClick={() => onSegmentClick?.(isSelected ? null : seg.label)}
              className={`flex items-center gap-1.5 rounded-full px-1.5 py-0.5 transition-colors ${
                isSelected
                  ? "bg-stone-900 text-white"
                  : "hover:bg-stone-100"
              }`}
              disabled={!onSegmentClick}
            >
              <span
                className={`inline-block h-2 w-2 rounded-sm ${seg.bgClass}`}
              />
              <span>{seg.displayLabel ?? seg.label}</span>
              {onSegmentMerge && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSegmentMerge(seg.label);
                  }}
                  className="ml-0.5 text-[9px] text-stone-300 hover:text-violet-600"
                  title={`Merge "${seg.displayLabel ?? seg.label}" into…`}
                >
                  ⋯
                </button>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
