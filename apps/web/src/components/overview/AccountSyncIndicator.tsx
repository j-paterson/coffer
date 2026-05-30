import { useEffect, useState } from "react";
import type { AccountMode } from "../../../../../packages/shared/types";
import { useAccountSyncStatus, useSyncRunning } from "../../lib/syncStream";

const TERMINAL_FADE_MS = 5000;

export function AccountSyncIndicator({
  accountId,
  mode,
}: {
  accountId: string;
  mode: AccountMode;
}) {
  const status = useAccountSyncStatus(accountId);
  const running = useSyncRunning();
  const [showTerminal, setShowTerminal] = useState(true);

  useEffect(() => {
    setShowTerminal(true);
    if (status?.state === "ok" || status?.state === "error") {
      const t = setTimeout(() => setShowTerminal(false), TERMINAL_FADE_MS);
      return () => clearTimeout(t);
    }
  }, [status?.state]);

  if (!status) {
    if (running && mode === "live") {
      return (
        <span
          className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-stone-400"
          title="Queued for sync…"
        />
      );
    }
    return null;
  }
  if (status.state === "active") {
    return (
      <span
        className="ml-2 inline-block h-1 w-12 overflow-hidden rounded-full bg-stone-200"
        title={`Syncing via ${status.source}…`}
      >
        <span className="block h-full w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-violet-500" />
      </span>
    );
  }
  if (!showTerminal) return null;
  if (status.state === "ok") {
    return <span className="ml-2 text-xs text-emerald-600">✓</span>;
  }
  return <span className="ml-2 text-xs text-red-600" title="Sync failed">✗</span>;
}
