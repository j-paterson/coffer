// apps/web/src/components/ConnectProviderModal.tsx
import { useState } from "react";
import type { ProviderMeta } from "../../../../packages/shared/providers";

interface Props {
  provider: ProviderMeta;
  pending: boolean;
  error: string | null;
  onSubmit: (fields: Record<string, string>) => void;
  onCancel: () => void;
  /** "connect" requires all secret fields; "edit" keeps already-set ones. */
  mode?: "connect" | "edit";
  /** Pre-fill values keyed by field.key (config only; secrets never pre-filled). */
  initialConfig?: Record<string, string>;
  /** Field keys whose secret is already set (edit mode → not required, shows placeholder). */
  setSecretKeys?: string[];
}

export function ConnectProviderModal({
  provider,
  pending,
  error,
  onSubmit,
  onCancel,
  mode = "connect",
  initialConfig,
  setSecretKeys = [],
}: Props) {
  const isEdit = mode === "edit";
  const secretSet = new Set(setSecretKeys);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(initialConfig ?? {}) }));
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const requiredOk = provider.fields.every((f) => {
    if (!f.secretName) return true;
    const typed = (values[f.key] ?? "").trim() !== "";
    return typed || (isEdit && secretSet.has(f.key));
  });

  const handleSubmit = () => {
    // Omit blank fields so the server's keep-if-blank logic preserves untouched secrets.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v.trim() !== "") out[k] = v;
    }
    onSubmit(out);
  };

  return (
    <div
      role="dialog"
      aria-label={`${isEdit ? "Edit" : "Connect"} ${provider.label}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!requiredOk) return;
          handleSubmit();
        }}
        className="w-96 rounded-lg border border-stone-200 bg-white p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold text-stone-900">
          {isEdit ? "Edit" : "Connect"} {provider.label}
        </h2>
        {provider.fields.map((f) => {
          const placeholder =
            isEdit && f.secretName && secretSet.has(f.key) ? "•••• set — leave blank to keep" : undefined;
          return (
            <label key={f.key} className="mb-3 block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-stone-500">{f.label}</span>
              {f.kind === "textarea" ? (
                <textarea
                  aria-label={f.label}
                  rows={f.multi ? 3 : 5}
                  placeholder={placeholder}
                  className="w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs outline-none focus:border-stone-500"
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : (
                <input
                  aria-label={f.label}
                  type={f.kind === "password" ? "password" : "text"}
                  placeholder={placeholder}
                  className="w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </label>
          );
        })}
        {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-stone-200 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50">
            Cancel
          </button>
          <button type="submit" disabled={!requiredOk || pending} className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:bg-stone-300">
            {pending ? "…" : isEdit ? "Save" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
