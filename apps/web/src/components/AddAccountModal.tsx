// apps/web/src/components/AddAccountModal.tsx
import { useState } from "react";
import {
  ACCOUNT_CATEGORIES,
  categoryMeta,
  type AccountCategory,
} from "../../../../packages/shared/accountCategory";

interface Props {
  pending: boolean;
  onSubmit: (data: {
    display_name: string;
    category: AccountCategory;
    institution?: string;
    balance: number;
    as_of: string;
  }) => void;
  onCancel: () => void;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export function AddAccountModal({ pending, onSubmit, onCancel }: Props) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<AccountCategory>("checking");
  const [institution, setInstitution] = useState("");
  const [balanceText, setBalanceText] = useState("");
  const [asOf, setAsOf] = useState(todayISO());

  const meta = categoryMeta(category);
  const balance = Number(balanceText);
  const valid = name.trim() !== "" && balanceText !== "" && Number.isFinite(balance) && balance >= 0;

  const assets = ACCOUNT_CATEGORIES.filter((c) => c.group === "asset");
  const liabilities = ACCOUNT_CATEGORIES.filter((c) => c.group === "liability");

  return (
    <div
      role="dialog"
      aria-label="Add account"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onSubmit({
            display_name: name.trim(),
            category,
            institution: institution.trim() || undefined,
            balance,
            as_of: asOf,
          });
        }}
        className="w-96 rounded-lg border border-stone-200 bg-white p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold text-stone-900">Add account</h2>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">Category</span>
          <select
            className="w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
            value={category}
            onChange={(e) => setCategory(e.target.value as AccountCategory)}
          >
            <optgroup label="Assets">
              {assets.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </optgroup>
            <optgroup label="Liabilities">
              {liabilities.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </optgroup>
          </select>
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">Name</span>
          <input
            type="text"
            autoFocus
            className="w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Emergency Fund"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">Institution (optional)</span>
          <input
            type="text"
            className="w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="e.g. Acme Bank"
          />
        </label>

        <div className="mb-1 flex gap-3">
          <label className="block flex-1">
            <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">{meta.balanceLabel}</span>
            <div className="flex items-center rounded-md border border-stone-300 px-3 py-2 focus-within:border-stone-500">
              <span className="text-stone-400">$</span>
              <input
                type="number"
                step="any"
                min="0"
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
        {meta.liability && (
          <p className="mb-1 text-[11px] text-stone-400">Tracked as a debt (reduces net worth).</p>
        )}

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
            {pending ? "…" : "Add account"}
          </button>
        </div>
      </form>
    </div>
  );
}
