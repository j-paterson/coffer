import { ProviderCardList } from "../components/ProviderCardList";

export function Settings() {
  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-6 text-sm text-stone-500">
        Connect data providers to sync accounts automatically. Secrets are stored
        locally and never leave this machine.
      </p>
      <ProviderCardList />
    </div>
  );
}
