import { useRef, useState } from "react";
import type { CategoryOption } from "../lib/api";

interface Props {
  options: CategoryOption[];
  onSave: (next: CategoryOption[]) => Promise<void>;
}

function optionsEqual(a: CategoryOption[], b: CategoryOption[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (row, i) =>
      row.category === b[i].category &&
      row.subcategories.length === b[i].subcategories.length &&
      row.subcategories.every((s, j) => s === b[i].subcategories[j]),
  );
}

export function BundleCategoryOptionsEditor({ options, onSave }: Props) {
  const [rows, setRows] = useState<CategoryOption[]>(() =>
    options.map((o) => ({ ...o, subcategories: [...o.subcategories] })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track each row's chip input text separately
  const [chipInputs, setChipInputs] = useState<string[]>(() =>
    options.map(() => ""),
  );
  // Stable identity per row so React keys survive reordering. Without
  // this, ▲/▼ would reuse the DOM node at the original index, leaving
  // browser focus on the visually-wrong row's input after a swap.
  const nextIdRef = useRef(options.length);
  const [rowIds, setRowIds] = useState<number[]>(() =>
    options.map((_, i) => i),
  );

  const isDirty = !optionsEqual(rows, options);

  function updateRow(i: number, patch: Partial<CategoryOption>) {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  function addRow() {
    setRows((prev) => [...prev, { category: "", subcategories: [] }]);
    setChipInputs((prev) => [...prev, ""]);
    setRowIds((prev) => [...prev, nextIdRef.current++]);
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setChipInputs((prev) => prev.filter((_, idx) => idx !== i));
    setRowIds((prev) => prev.filter((_, idx) => idx !== i));
  }

  function moveRow(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    setRows((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setChipInputs((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setRowIds((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function addSubcategory(rowIdx: number) {
    const text = chipInputs[rowIdx].trim();
    if (!text) return;
    if (rows[rowIdx].subcategories.includes(text)) {
      setChipInputs((prev) => {
        const next = [...prev];
        next[rowIdx] = "";
        return next;
      });
      return;
    }
    updateRow(rowIdx, {
      subcategories: [...rows[rowIdx].subcategories, text],
    });
    setChipInputs((prev) => {
      const next = [...prev];
      next[rowIdx] = "";
      return next;
    });
  }

  function removeSubcategory(rowIdx: number, subIdx: number) {
    updateRow(rowIdx, {
      subcategories: rows[rowIdx].subcategories.filter(
        (_, idx) => idx !== subIdx,
      ),
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave(rows);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div
          key={rowIds[i]}
          className="rounded-md border border-stone-200 bg-white p-3"
        >
          <div className="mb-2 flex items-center gap-2">
            {/* Reorder arrows */}
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => moveRow(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="text-[10px] leading-none text-stone-400 hover:text-stone-700 disabled:opacity-30"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => moveRow(i, 1)}
                disabled={i === rows.length - 1}
                title="Move down"
                className="text-[10px] leading-none text-stone-400 hover:text-stone-700 disabled:opacity-30"
              >
                ▼
              </button>
            </div>

            {/* Category name */}
            <input
              type="text"
              value={row.category}
              onChange={(e) => updateRow(i, { category: e.target.value })}
              placeholder="Category name"
              data-testid="category-options-input"
              className="flex-1 rounded-md border border-stone-200 px-2 py-1 text-sm focus:border-stone-400 focus:outline-none"
            />

            {/* Remove row */}
            <button
              type="button"
              onClick={() => removeRow(i)}
              title="Remove category"
              className="text-xs text-stone-400 hover:text-rose-600"
            >
              ✕
            </button>
          </div>

          {/* Subcategory chips */}
          <div className="ml-6 flex flex-wrap items-center gap-1">
            {row.subcategories.map((sub, j) => (
              <span
                key={j}
                className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-700"
              >
                {sub}
                <button
                  type="button"
                  onClick={() => removeSubcategory(i, j)}
                  className="text-stone-400 hover:text-rose-600"
                  title="Remove subcategory"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              value={chipInputs[i]}
              onChange={(e) => {
                const val = e.target.value;
                setChipInputs((prev) => {
                  const next = [...prev];
                  next[i] = val;
                  return next;
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addSubcategory(i);
                }
              }}
              onBlur={() => addSubcategory(i)}
              placeholder="+ subcategory"
              className="min-w-[100px] rounded border-0 bg-transparent px-1 py-0.5 text-[11px] text-stone-500 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-300"
            />
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={addRow}
          data-testid="category-options-add"
          className="text-xs font-medium text-stone-500 hover:text-stone-800"
        >
          + Add category
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>

        {error && <span className="text-xs text-rose-700">{error}</span>}
      </div>
    </div>
  );
}
