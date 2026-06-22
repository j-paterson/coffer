// apps/web/src/routes/Welcome.tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccounts, useConnections, useCreateAccount } from "../lib/queries";
import { ProviderCardList } from "../components/ProviderCardList";
import { AddAccountModal } from "../components/AddAccountModal";
import { markOnboarded } from "../lib/onboarding";

const STEP_COUNT = 4;

export function Welcome() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const { data: accounts } = useAccounts();
  const { data: conns } = useConnections();
  const createAccount = useCreateAccount();

  const manualAccounts = (accounts ?? []).filter((a) => a.mode === "manual");
  const connectedCount = (conns ?? []).filter((c) => c.connected).length;

  const complete = () => {
    markOnboarded();
    navigate("/", { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 p-6">
      <div className="w-full max-w-2xl rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-xs font-medium uppercase tracking-wider text-stone-400">
          Step {step + 1} of {STEP_COUNT}
        </div>

        {step === 0 && (
          <div>
            <h1 className="mb-2 text-2xl font-semibold tracking-tight">Welcome to Coffer</h1>
            <p className="text-sm text-stone-600">
              A local, self-hosted view of your net worth. Connect your banks and
              wallets, or add accounts by hand — your data stays on this machine.
            </p>
          </div>
        )}

        {step === 1 && (
          <div>
            <h1 className="mb-1 text-2xl font-semibold tracking-tight">Connect providers</h1>
            <p className="mb-4 text-sm text-stone-600">
              Link a bank, exchange, or wallet to sync automatically — optional, and
              you can always do this later from Settings. {connectedCount} connected.
            </p>
            <ProviderCardList />
          </div>
        )}

        {step === 2 && (
          <div>
            <h1 className="mb-1 text-2xl font-semibold tracking-tight">Add accounts manually</h1>
            <p className="mb-4 text-sm text-stone-600">
              Track cash, real estate, or anything else by hand — optional.
            </p>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="rounded-md border border-stone-200 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50"
            >
              + Add account
            </button>
            <ul className="mt-4 space-y-1 text-sm text-stone-700">
              {manualAccounts.length === 0 ? (
                <li className="text-stone-400">No manual accounts yet.</li>
              ) : (
                manualAccounts.map((a) => (
                  <li key={a.id} className="flex justify-between border-b border-stone-100 py-1">
                    <span>{a.display_name_override ?? a.display_name}</span>
                    <span className="text-stone-400">{a.institution}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}

        {step === 3 && (
          <div>
            <h1 className="mb-2 text-2xl font-semibold tracking-tight">You're all set</h1>
            <p className="text-sm text-stone-600">
              {manualAccounts.length} manual account{manualAccounts.length === 1 ? "" : "s"} ·{" "}
              {connectedCount} provider{connectedCount === 1 ? "" : "s"} connected.
            </p>
          </div>
        )}

        <div className="mt-8 flex items-center justify-between">
          <button type="button" onClick={complete} className="text-xs text-stone-400 hover:text-stone-600">
            Skip for now
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="rounded-md border border-stone-200 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
              >
                Back
              </button>
            )}
            {step < STEP_COUNT - 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={complete}
                className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
              >
                Go to dashboard
              </button>
            )}
          </div>
        </div>

        {showAdd && (
          <AddAccountModal
            pending={createAccount.isPending}
            onSubmit={(data) => createAccount.mutate(data, { onSuccess: () => setShowAdd(false) })}
            onCancel={() => setShowAdd(false)}
          />
        )}
      </div>
    </div>
  );
}
