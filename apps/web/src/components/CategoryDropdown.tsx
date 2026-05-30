import { useEffect, useRef, useState } from "react";
import type { CategoryHierarchy } from "../../../../packages/shared/types";
import {
  formatCategory,
  normalizeCategory as normCat,
  sameCategory as sameCat,
} from "../../../../packages/shared/categories";

export interface CategoryDropdownProps {
  value: { category: string | null; subcategory: string | null };
  onChange: (next: { category: string | null; subcategory: string | null }) => void;
  hierarchy: CategoryHierarchy; // global taxonomy
  suggested?: CategoryHierarchy; // bundle bias, rendered first
  disabled?: boolean;
  /** Override the trigger label. Used by callers like the bulk-recategorize
   *  action bar where "Uncategorized" would be misleading. */
  triggerLabel?: string;
  /** Override the trigger button's className. Lets callers render a more
   *  prominent button instead of the inline pill default. */
  triggerClassName?: string;
}

/**
 * Two-pane hierarchical category + subcategory selector.
 *
 * Renders as a fixed-positioned popover (z-50). The parent is responsible for
 * positioning the trigger; the popover itself anchors near the trigger via a
 * triggerRef or falls back to a fixed centered position.
 *
 * Keyboard nav: Escape closes. Mouse-only selection within the panes.
 * TODO: keyboard nav (Up/Down within column, Tab to switch columns, Enter to
 * select) — deferred; complexity vs. value tradeoff for initial ship.
 */
export function CategoryDropdown({
  value,
  onChange,
  hierarchy,
  suggested = [],
  disabled = false,
  triggerLabel: triggerLabelOverride,
  triggerClassName,
}: CategoryDropdownProps) {
  const [open, setOpen] = useState(false);
  const [catFilter, setCatFilter] = useState("");
  const [subFilter, setSubFilter] = useState("");
  // Track which category is "hovered"/selected within the popover for
  // the subcategory column (starts from the current value, or the first
  // category in the list once open).
  const [activeCategory, setActiveCategory] = useState<string | null>(
    value.category,
  );

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const catInputRef = useRef<HTMLInputElement>(null);

  // Reset local state when popover opens.
  useEffect(() => {
    if (open) {
      setCatFilter("");
      setSubFilter("");
      setActiveCategory(value.category);
      // Focus the category filter input on open.
      setTimeout(() => catInputRef.current?.focus(), 0);
    }
  }, [open, value.category]);

  // Click-outside and Escape to close.
  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Build the merged category list: suggested first (deduplicated from global).
  // Comparisons must mirror the API's normalization so "Materials" (template,
  // verbatim) and "materials" (post-API-save item value) are treated as the
  // same category. Display labels keep their original form.
  const suggestedKeys = new Set(suggested.map((s) => normCat(s.category)));
  const globalOnly = hierarchy.filter(
    (h) => !suggestedKeys.has(normCat(h.category)),
  );

  // Filter categories by the category input text.
  const filterCat = (cat: string) =>
    catFilter === "" ||
    cat.toLowerCase().includes(catFilter.toLowerCase());

  const filteredSuggested = suggested.filter((s) => filterCat(s.category));
  const filteredGlobal = globalOnly.filter((g) => filterCat(g.category));

  // Subcategories for the active category (look in suggested first, then global).
  const activeCategoryEntry =
    suggested.find((s) => sameCat(s.category, activeCategory)) ??
    hierarchy.find((h) => sameCat(h.category, activeCategory));
  const subcategories = activeCategoryEntry?.subcategories ?? [];

  const filteredSubs = subcategories.filter(
    (s) =>
      subFilter === "" || s.toLowerCase().includes(subFilter.toLowerCase()),
  );

  // Detect "new" entries — typed text that doesn't match existing items exactly.
  const catInputLower = catFilter.toLowerCase();
  const allCategoryNames = [
    ...suggested.map((s) => s.category),
    ...globalOnly.map((g) => g.category),
  ];
  const isNewCategory =
    catFilter.trim() !== "" &&
    !allCategoryNames.some((c) => c.toLowerCase() === catInputLower);

  const subInputLower = subFilter.toLowerCase();
  const isNewSubcategory =
    activeCategory !== null &&
    subFilter.trim() !== "" &&
    !subcategories.some((s) => s.toLowerCase() === subInputLower);

  function selectCategory(cat: string) {
    setActiveCategory(cat);
    setSubFilter("");
    // Selecting a category moves focus to subcategory pane (via filter input).
    // The parent value is not committed until a subcategory is chosen or the
    // user explicitly calls selectCategoryOnly().
  }

  function selectCategoryOnly(cat: string) {
    onChange({ category: cat, subcategory: null });
    setOpen(false);
  }

  function selectSubcategory(sub: string) {
    onChange({ category: activeCategory, subcategory: sub });
    setOpen(false);
  }

  function handleCatKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (isNewCategory) {
        // Create: commit the typed category, no subcategory yet.
        onChange({ category: catFilter.trim(), subcategory: null });
        setOpen(false);
      } else if (filteredSuggested.length + filteredGlobal.length === 1) {
        // Exactly one match — auto-select it and move to subcategory.
        const only =
          filteredSuggested[0]?.category ?? filteredGlobal[0]?.category;
        if (only) selectCategory(only);
      }
    }
  }

  function handleSubKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (isNewSubcategory) {
        selectSubcategory(subFilter.trim());
      } else if (filteredSubs.length === 1) {
        selectSubcategory(filteredSubs[0]);
      }
    }
  }

  // Compute popover position anchored below the trigger button.
  // Falls back to top-left if triggerRef is not yet available.
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const pW = 480; // approximate popover width
    const pH = 300; // approximate popover height
    let top = rect.bottom + 4;
    let left = rect.left;
    if (left + pW > viewW - 8) left = viewW - pW - 8;
    if (left < 8) left = 8;
    if (top + pH > viewH - 8) top = rect.top - pH - 4;
    setPopoverStyle({ top, left });
  }, [open]);

  // Label for the trigger button.
  const computedTriggerLabel = value.category
    ? value.subcategory
      ? `${formatCategory(value.category)} / ${formatCategory(value.subcategory)}`
      : formatCategory(value.category)
    : "Uncategorized";
  const triggerLabel = triggerLabelOverride ?? computedTriggerLabel;
  const defaultTriggerClass = `rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide transition-colors ${
    value.category
      ? "bg-violet-50 text-violet-700 hover:bg-violet-100"
      : "border border-dashed border-stone-300 text-stone-400 hover:border-violet-400 hover:text-violet-600"
  } ${disabled ? "cursor-not-allowed opacity-50" : ""}`;

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        data-testid="category-trigger"
        className={triggerClassName ?? defaultTriggerClass}
        title={
          value.category
            ? `Category: ${triggerLabel} — click to change`
            : "Click to assign a category"
        }
      >
        {triggerLabel}
      </button>

      {open && (
        <div
          ref={popoverRef}
          style={{ position: "fixed", zIndex: 50, ...popoverStyle }}
          className="flex w-[480px] flex-col rounded-lg border border-stone-200 bg-white shadow-lg"
          // Prevent clicks inside the popover from bubbling to the outside
          // listener that would close it.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2">
            <span className="text-xs font-medium text-stone-600">
              Set category
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-stone-400 hover:text-stone-700"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Two-column body */}
          <div className="flex min-h-0">
            {/* Left column: categories */}
            <div className="flex w-1/2 flex-col border-r border-stone-100">
              <div className="border-b border-stone-100 px-2 py-1.5">
                <input
                  ref={catInputRef}
                  type="text"
                  value={catFilter}
                  onChange={(e) => setCatFilter(e.target.value)}
                  onKeyDown={handleCatKeyDown}
                  placeholder="Filter or create…"
                  className="w-full rounded border border-stone-200 px-2 py-1 text-xs outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-100"
                />
              </div>

              <div className="max-h-56 overflow-y-auto py-1">
                {/* Suggested section */}
                {filteredSuggested.length > 0 && (
                  <div data-testid="dropdown-suggested-group">
                    <div className="px-2 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-widest text-stone-400">
                      Suggested
                    </div>
                    {filteredSuggested.map(({ category }) => (
                      <CategoryRow
                        key={`s:${category}`}
                        category={category}
                        active={sameCat(activeCategory, category)}
                        selected={sameCat(value.category, category)}
                        onHover={() => selectCategory(category)}
                        onClick={() => selectCategoryOnly(category)}
                      />
                    ))}
                    {filteredGlobal.length > 0 && (
                      <div className="mx-2 my-1 border-t border-stone-100" />
                    )}
                  </div>
                )}

                {/* Global section */}
                {filteredGlobal.length > 0 && (
                  <>
                    {filteredSuggested.length > 0 && (
                      <div className="px-2 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-widest text-stone-400">
                        All
                      </div>
                    )}
                    {filteredGlobal.map(({ category }) => (
                      <CategoryRow
                        key={`g:${category}`}
                        category={category}
                        active={sameCat(activeCategory, category)}
                        selected={sameCat(value.category, category)}
                        onHover={() => selectCategory(category)}
                        onClick={() => selectCategoryOnly(category)}
                      />
                    ))}
                  </>
                )}

                {/* New category option */}
                {isNewCategory && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange({ category: catFilter.trim(), subcategory: null });
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-violet-700 hover:bg-violet-50"
                  >
                    <span className="text-[10px] text-violet-400">+</span>
                    <span>
                      Create &ldquo;{catFilter.trim()}&rdquo;
                    </span>
                  </button>
                )}

                {filteredSuggested.length === 0 &&
                  filteredGlobal.length === 0 &&
                  !isNewCategory && (
                    <p className="px-3 py-2 text-xs text-stone-400">
                      No categories
                    </p>
                  )}
              </div>
            </div>

            {/* Right column: subcategories of active category */}
            <div className="flex w-1/2 flex-col">
              {activeCategory ? (
                <>
                  <div className="border-b border-stone-100 px-2 py-1.5">
                    <input
                      type="text"
                      value={subFilter}
                      onChange={(e) => setSubFilter(e.target.value)}
                      onKeyDown={handleSubKeyDown}
                      placeholder="Filter or create…"
                      className="w-full rounded border border-stone-200 px-2 py-1 text-xs outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-100"
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1">
                    {/* "No subcategory" option */}
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onChange({ category: activeCategory, subcategory: null });
                        setOpen(false);
                      }}
                      className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-stone-50 ${
                        sameCat(value.category, activeCategory) &&
                        value.subcategory === null
                          ? "font-medium text-violet-700"
                          : "text-stone-400"
                      }`}
                    >
                      (none)
                    </button>

                    {filteredSubs.map((sub) => (
                      <button
                        key={sub}
                        type="button"
                        data-testid="subcategory-row"
                        data-subcategory={sub}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSubcategory(sub);
                        }}
                        className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-violet-50 ${
                          sameCat(value.category, activeCategory) &&
                          value.subcategory === sub
                            ? "font-medium text-violet-700"
                            : "text-stone-700"
                        }`}
                      >
                        {formatCategory(sub)}
                      </button>
                    ))}

                    {/* New subcategory option */}
                    {isNewSubcategory && (
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSubcategory(subFilter.trim());
                        }}
                        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-violet-700 hover:bg-violet-50"
                      >
                        <span className="text-[10px] text-violet-400">+</span>
                        <span>
                          Create &ldquo;{subFilter.trim()}&rdquo;
                        </span>
                      </button>
                    )}

                    {filteredSubs.length === 0 && !isNewSubcategory && (
                      <p className="px-3 py-2 text-xs text-stone-400">
                        No subcategories
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-xs text-stone-400">
                    Select a category first
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Footer: current selection summary */}
          <div className="border-t border-stone-100 px-3 py-1.5 text-[10px] text-stone-400">
            {value.category ? (
              <span>
                Current:{" "}
                <span className="font-medium text-stone-600">
                  {formatCategory(value.category)}
                  {value.subcategory ? ` / ${formatCategory(value.subcategory)}` : ""}
                </span>
                {" · "}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange({ category: null, subcategory: null });
                    setOpen(false);
                  }}
                  className="text-stone-400 underline hover:text-stone-600"
                >
                  clear
                </button>
              </span>
            ) : (
              <span>No category set</span>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function CategoryRow({
  category,
  active,
  selected,
  onHover,
  onClick,
}: {
  category: string;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="category-row"
      data-category={category}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors ${
        active
          ? "bg-stone-100 text-stone-900"
          : "text-stone-700 hover:bg-stone-50"
      } ${selected ? "font-medium" : ""}`}
    >
      <span>{formatCategory(category)}</span>
      {active && (
        <span className="text-[9px] text-stone-400">▶</span>
      )}
    </button>
  );
}
