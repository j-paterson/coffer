import { useState } from "react";
import type { Goal } from "../lib/api";

interface Props {
  goal: Goal | null;
  pending: boolean;
  onSubmit: (data: { name: string; target_amount: number; due_date: string | null }) => void;
  onCancel: () => void;
}

export function GoalEditModal({ goal, pending, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(goal?.name ?? "");
  const [targetText, setTargetText] = useState(
    goal ? String(goal.target_amount) : "",
  );
  const [dueDate, setDueDate] = useState(goal?.due_date ?? "");
  const [hasDueDate, setHasDueDate] = useState(Boolean(goal?.due_date));

  const target = Number(targetText);
  const valid =
    name.trim().length > 0 &&
    targetText !== "" &&
    Number.isFinite(target) &&
    target > 0 &&
    (!hasDueDate || /^\d{4}-\d{2}-\d{2}$/.test(dueDate));

  const isEdit = goal !== null;

  return (
    <div
      role="dialog"
      aria-label={isEdit ? "Edit goal" : "New goal"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onSubmit({
            name: name.trim(),
            target_amount: target,
            due_date: hasDueDate ? dueDate : null,
          });
        }}
        className="w-96 rounded-lg border border-stone-200 bg-white p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold text-stone-900">
          {isEdit ? "Edit goal" : "New goal"}
        </h2>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">Name</span>
          <input
            type="text"
            autoFocus
            className="w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">Target</span>
          <div className="flex items-center rounded-md border border-stone-300 px-3 py-2 focus-within:border-stone-500">
            <span className="text-stone-400">$</span>
            <input
              type="number"
              step="any"
              min="0"
              className="ml-2 flex-1 bg-transparent outline-none"
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
            />
          </div>
        </label>

        <div className="mb-5">
          <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">Due date</span>
          {hasDueDate ? (
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="flex-1 rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  setHasDueDate(false);
                  setDueDate("");
                }}
                className="text-xs text-stone-500 underline hover:text-stone-700"
              >
                no due date
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setHasDueDate(true)}
              className="text-xs text-stone-500 underline hover:text-stone-700"
            >
              + add due date
            </button>
          )}
        </div>

        <div className="flex justify-end gap-2">
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
            {pending ? "…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
