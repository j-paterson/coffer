// apps/web/src/components/ProviderCardList.tsx
import { useState } from "react";
import { PROVIDERS, getProvider } from "../../../../packages/shared/providers";
import {
  useConnections,
  useConnectProvider,
  useDisconnectProvider,
  useSetProviderEnabled,
  useSyncProvider,
} from "../lib/queries";
import { ConnectProviderModal } from "./ConnectProviderModal";

export function ProviderCardList() {
  const { data: conns } = useConnections();
  const connect = useConnectProvider();
  const disconnect = useDisconnectProvider();
  const setEnabled = useSetProviderEnabled();
  const syncProvider = useSyncProvider();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusOf = (id: string) => conns?.find((c) => c.id === id);

  const initialConfigFor = (provider: typeof PROVIDERS[number], conn: ReturnType<typeof statusOf>) => {
    const out: Record<string, string> = {};
    for (const f of provider.fields) {
      if (f.configKey) {
        const v = conn?.config?.[f.configKey];
        out[f.key] = f.multi && Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v);
      }
    }
    return out;
  };
  const setSecretKeysFor = (provider: typeof PROVIDERS[number], conn: ReturnType<typeof statusOf>) =>
    provider.fields.filter((f) => f.secretName && (conn?.configuredSecrets ?? []).includes(f.secretName)).map((f) => f.key);

  return (
    <>
      <ul className="space-y-3">
        {PROVIDERS.map((p) => {
          const s = statusOf(p.id);
          const connected = s?.connected ?? false;
          return (
            <li key={p.id} className="flex items-center justify-between rounded-lg border border-stone-200 bg-white p-4">
              <div>
                <div className="text-sm font-medium text-stone-900">{p.label}</div>
                <div className="mt-0.5 text-xs">
                  {p.needsAuth ? (
                    connected ? (
                      <span className="text-emerald-600">Connected</span>
                    ) : (
                      <span className="text-stone-400">Not connected</span>
                    )
                  ) : (
                    <span className="text-stone-400">
                      {s?.enabled === false ? "Disabled" : "Enabled"} · price data, no sign-in needed
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {((p.needsAuth && connected) || (!p.needsAuth && s?.enabled !== false)) && (
                  <button
                    type="button"
                    onClick={() => syncProvider.mutate({ id: p.id })}
                    className="rounded-md border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    Sync now
                  </button>
                )}
                {p.needsAuth ? (
                  connected ? (
                    <>
                      <button
                        type="button"
                        onClick={() => { setError(null); setEditing(p.id); }}
                        className="rounded-md border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => disconnect.mutate({ id: p.id })}
                        className="rounded-md border border-stone-200 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setError(null); setConnecting(p.id); }}
                      className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-700"
                    >
                      Connect
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => setEnabled.mutate({ id: p.id, enabled: !(s?.enabled ?? true) })}
                    className="rounded-md border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    {s?.enabled === false ? "Enable" : "Disable"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {connecting && (
        <ConnectProviderModal
          provider={getProvider(connecting)!}
          pending={connect.isPending}
          error={error}
          onSubmit={(fields) => {
            setError(null);
            connect.mutate(
              { id: connecting, fields },
              {
                onSuccess: () => setConnecting(null),
                onError: (e) => setError((e as Error).message),
              },
            );
          }}
          onCancel={() => setConnecting(null)}
        />
      )}

      {editing && (() => {
        const prov = getProvider(editing)!;
        const conn = statusOf(editing);
        return (
          <ConnectProviderModal
            provider={prov}
            mode="edit"
            pending={connect.isPending}
            error={error}
            initialConfig={initialConfigFor(prov, conn)}
            setSecretKeys={setSecretKeysFor(prov, conn)}
            onSubmit={(fields) => {
              setError(null);
              connect.mutate(
                { id: editing, fields },
                {
                  onSuccess: () => setEditing(null),
                  onError: (e) => setError((e as Error).message),
                },
              );
            }}
            onCancel={() => setEditing(null)}
          />
        );
      })()}
    </>
  );
}
