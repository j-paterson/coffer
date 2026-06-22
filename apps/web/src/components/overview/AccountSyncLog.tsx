import { useAccountSyncStatus } from "../../lib/syncStream";

const VISIBLE_LINES = 6;

export function AccountSyncLog({ accountId }: { accountId: string }) {
  const status = useAccountSyncStatus(accountId);
  if (!status || status.state !== "active") return null;
  const lines = status.log.slice(-VISIBLE_LINES);
  if (lines.length === 0) {
    return (
      <div className="ml-7 mt-1 font-mono text-[11px] text-stone-400">
        starting…
      </div>
    );
  }
  return (
    <div className="ml-7 mt-1 space-y-0.5 font-mono text-[11px] text-stone-500">
      {lines.map((l, i) => (
        <div key={i}>{l.message}</div>
      ))}
    </div>
  );
}
