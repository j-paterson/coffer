import { useState } from "react";
import { GoalAmountModal } from "../components/GoalAmountModal";
import { GoalCard } from "../components/GoalCard";
import { GoalEditModal } from "../components/GoalEditModal";
import type { Goal } from "../lib/api";
import { usePrivateFormat } from "../lib/privacy";
import {
  useAllocateGoal,
  useArchiveGoal,
  useCreateGoal,
  useDeleteGoal,
  useGoals,
  useUpdateGoal,
} from "../lib/queries";

type AmountModalState =
  | { kind: "add"; goal: Goal }
  | { kind: "drawdown"; goal: Goal }
  | null;

type EditModalState =
  | { kind: "create" }
  | { kind: "edit"; goal: Goal }
  | null;

export function Goals() {
  const [showArchived, setShowArchived] = useState(false);
  const [amountModal, setAmountModal] = useState<AmountModalState>(null);
  const [editModal, setEditModal] = useState<EditModalState>(null);
  const fmt = usePrivateFormat();

  const goalsQ = useGoals(showArchived);
  const createMut = useCreateGoal();
  const updateMut = useUpdateGoal();
  const allocateMut = useAllocateGoal();
  const archiveMut = useArchiveGoal();
  const deleteMut = useDeleteGoal();

  if (goalsQ.error) return <pre className="text-red-700">{String(goalsQ.error)}</pre>;
  if (!goalsQ.data) return <p className="text-stone-500">loading…</p>;

  const goals = goalsQ.data.goals;
  const activeGoals = goals.filter((g) => !g.completed_at);
  const totalEarmarked = activeGoals.reduce((s, g) => s + g.allocated_amount, 0);

  return (
    <div className="max-w-5xl">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Goals</h1>
        <button
          type="button"
          onClick={() => setEditModal({ kind: "create" })}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800"
        >
          + New goal
        </button>
      </header>

      {goals.length === 0 ? (
        <EmptyState onCreate={() => setEditModal({ kind: "create" })} />
      ) : (
        <>
          <div className="mb-4 flex items-baseline justify-between text-sm text-stone-500">
            <span>
              Total earmarked: <span className="font-semibold text-stone-900">{fmt.amount(totalEarmarked)}</span>{" "}
              across {activeGoals.length} goal{activeGoals.length === 1 ? "" : "s"}
            </span>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {goals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                onAdd={() => setAmountModal({ kind: "add", goal: g })}
                onDrawdown={() => setAmountModal({ kind: "drawdown", goal: g })}
                onEdit={() => setEditModal({ kind: "edit", goal: g })}
                onArchive={() => archiveMut.mutate(g.id)}
                onDelete={() => {
                  if (confirm(`Delete "${g.name}"? This can't be undone.`)) {
                    deleteMut.mutate(g.id);
                  }
                }}
              />
            ))}
          </div>
        </>
      )}

      {amountModal && (
        <GoalAmountModal
          goalName={amountModal.goal.name}
          mode={amountModal.kind}
          pending={allocateMut.isPending}
          onCancel={() => setAmountModal(null)}
          onSubmit={(amount) => {
            allocateMut.mutate(
              { id: amountModal.goal.id, amount },
              { onSuccess: () => setAmountModal(null) },
            );
          }}
        />
      )}

      {editModal && (
        <GoalEditModal
          goal={editModal.kind === "edit" ? editModal.goal : null}
          pending={createMut.isPending || updateMut.isPending}
          onCancel={() => setEditModal(null)}
          onSubmit={(data) => {
            if (editModal.kind === "edit") {
              updateMut.mutate(
                { id: editModal.goal.id, patch: data },
                { onSuccess: () => setEditModal(null) },
              );
            } else {
              createMut.mutate(data, { onSuccess: () => setEditModal(null) });
            }
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 bg-stone-50 px-6 py-16 text-center">
      <h2 className="text-lg font-semibold text-stone-700">Set your first savings goal</h2>
      <p className="mt-1 max-w-sm text-sm text-stone-500">
        Track money committed toward a future expense (property tax, repairs, vacation, etc.)
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-5 rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
      >
        + Create a goal
      </button>
    </div>
  );
}
