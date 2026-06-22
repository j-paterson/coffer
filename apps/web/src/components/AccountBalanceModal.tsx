import { useState } from "react";

interface Props {
  accountName: string;
  liability: boolean;
  pending: boolean;
  onSubmit: (data: { balance: number; as_of: string }) => void;
  onCancel: () => void;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export function AccountBalanceModal({ accountName, liability, pending, onSubmit, onCancel }: Props) {
  const [balanceText, setBalanceText] = useState("");
  const [asOf, setAsOf] = useState(todayISO());
  const balance = Number(balanceText);
  const valid = balanceText !== "" && Number.isFinite(balance) && balance >= 0;

  return (
    <div
      role="dialog"
      aria-label={`Update balance for ${accountName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onSubmit({ balance, as_of: asOf });
        }}
        className="w-80 rounded-lg border border-stone-200 bg-white p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold text-stone-900">Update "{accountName}"</h2>
        <div className="flex gap-3">
          <label className="block flex-1">
            <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">
              {liability ? "Amount owed" : "Balance"}
            </span>
            <div className="flex items-center rounded-md border border-stone-300 px-3 py-2 focus-within:border-stone-500">
              <span className="text-stone-400">$</span>
              <input
                type="number"
                step="any"
                min="0"
                autoFocus
                className="ml-2 w-full bg-transparent outline-none"
                value={balanceText}
                onChange={(e) => setBalanceText(e.target.value)}
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">As of</span>
            <input
              type="date"
              className="rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </label>
        </div>
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
            {pending ? "…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
