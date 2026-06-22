import { useEffect, useRef } from "react";

interface Props {
  /** Top-left corner of the menu, in viewport coords. */
  x: number;
  y: number;
  currentlyExcluded: boolean;
  onSelect: () => void;
  onDismiss: () => void;
}

/** One-item floating menu. Click-outside or Escape dismisses; clicking
 *  the item invokes onSelect (the parent then calls onDismiss as needed). */
export function IgnoreContextMenu({ x, y, currentlyExcluded, onSelect, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 50 }}
      className="min-w-[10rem] rounded-md border border-stone-200 bg-white py-1 text-sm shadow-md"
    >
      <button
        type="button"
        role="menuitem"
        onClick={onSelect}
        className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-100"
      >
        {currentlyExcluded ? "Un-ignore" : "Ignore in spending"}
      </button>
    </div>
  );
}
