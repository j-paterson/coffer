import { useState } from "react";
import type { Goal } from "../lib/api";
import { usePrivateFormat } from "../lib/privacy";

interface Props {
  goal: Goal;
  onAdd: () => void;
  onDrawdown: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function formatMonth(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function GoalCard({ goal, onAdd, onDrawdown, onEdit, onArchive, onDelete }: Props) {
  const fmt = usePrivateFormat();
  const [menuOpen, setMenuOpen] = useState(false);

  const subline = `of ${fmt.amount(goal.target_amount)} · ${Math.round(goal.pct_funded)}%`;

  let pace: string;
  if (goal.is_funded) {
    pace = "Funded";
  } else if (goal.due_date && goal.monthly_pace !== undefined) {
    pace = `${fmt.amount(goal.monthly_pace)}/mo · ${formatMonth(goal.due_date)}`;
  } else {
    pace = "contingent";
  }

  return (
    <div className="relative flex flex-col rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="text-[10px] font-medium uppercase tracking-wider text-stone-500">
        {goal.name}
      </div>
      <div className="mt-1 text-2xl font-semibold text-stone-900">
        {fmt.amount(goal.allocated_amount)}
      </div>
      <div className="text-xs text-stone-500">{subline}</div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-stone-100">
        <div
          className={`h-full ${goal.is_funded ? "bg-emerald-500" : "bg-stone-700"}`}
          style={{ width: `${Math.min(goal.pct_funded, 100)}%` }}
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-stone-500">
        <span>{pace}</span>
        {goal.is_funded && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700">
            Funded
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-800"
        >
          Add
        </button>
        <button
          type="button"
          onClick={onDrawdown}
          className="rounded-md border border-stone-200 px-2.5 py-1 text-xs text-stone-700 hover:bg-stone-50"
        >
          Drawn down
        </button>
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More actions"
            className="rounded-md px-2 py-1 text-stone-400 hover:bg-stone-50 hover:text-stone-700"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 z-10 w-32 rounded-md border border-stone-200 bg-white py-1 text-xs shadow-lg">
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onEdit(); }}
                className="block w-full px-3 py-1.5 text-left hover:bg-stone-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onArchive(); }}
                className="block w-full px-3 py-1.5 text-left hover:bg-stone-50"
              >
                Archive
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onDelete(); }}
                className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-stone-50"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
