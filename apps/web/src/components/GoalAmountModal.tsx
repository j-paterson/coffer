import { useState } from "react";

interface Props {
  goalName: string;
  mode: "add" | "drawdown";
  pending: boolean;
  onSubmit: (amount: number) => void;
  onCancel: () => void;
}

export function GoalAmountModal({ goalName, mode, pending, onSubmit, onCancel }: Props) {
  const [text, setText] = useState("");
  const amount = Number(text);
  const valid = text !== "" && Number.isFinite(amount) && amount > 0;
  const verb = mode === "add" ? "Add" : "Drawn down";
  const title = mode === "add" ? `Add to "${goalName}"` : `Drawn down from "${goalName}"`;

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const signed = mode === "add" ? amount : -amount;
          onSubmit(signed);
        }}
        className="w-80 rounded-lg border border-stone-200 bg-white p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold text-stone-900">{title}</h2>
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">Amount</span>
          <div className="flex items-center rounded-md border border-stone-300 px-3 py-2 focus-within:border-stone-500">
            <span className="text-stone-400">$</span>
            <input
              type="number"
              step="any"
              min="0"
              autoFocus
              className="ml-2 flex-1 bg-transparent outline-none"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-stone-200 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || pending}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:bg-stone-300"
          >
            {pending ? "…" : verb}
          </button>
        </div>
      </form>
    </div>
  );
}
