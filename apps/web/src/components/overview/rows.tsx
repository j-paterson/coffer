/** Interactive account-row components for the Overview page.
 *
 * Originally inline in Overview.tsx; extracted to keep that file focused
 * on page orchestration. Three row variants:
 *
 *   - AccountRow         — any regular account (checking/credit/brokerage/etc.)
 *   - WalletRow          — a Zerion EVM wallet aggregated across chains
 *   - ExchangeRow        — a bundled crypto exchange (Coinbase, etc.)
 *
 * Plus the wallet-history + holdings-history chart wrappers and the
 * crypto-grouping helper `renderCryptoGrouped`.
 */

import { useState } from "react";
import type { Account } from "../../lib/api";
import { formatDate, formatPct } from "../../lib/format";
import { usePrivateFormat } from "../../lib/privacy";
import { usePatchAccountName } from "../../lib/queries";
import { AccountSyncIndicator } from "./AccountSyncIndicator";
import { AccountSyncLog } from "./AccountSyncLog";

interface RowSelection {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function AccountRow({
  account: a,
  selectedId,
  onSelect,
}: { account: Account } & RowSelection) {
  const fmt = usePrivateFormat();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(a.display_name_override ?? "");
  const [overrideName, setOverrideName] = useState(a.display_name_override);
  const isLive = a.mode === "live";
  const isSelected = selectedId === a.id;
  const dimmed =
    a.active === 0 ? "opacity-50" : !isLive ? "opacity-70" : "";
  const displayName = overrideName ?? a.display_name;
  // For on-chain wallet rows, the chain name is already visible in the
  // account name / grouping. The grey subline is more useful as the
  // actual wallet address so the user can eyeball which hex wallet this
  // is without expanding the row.
  const walletAddr = walletAddressOf(a.id);
  const subline = walletAddr
    ? `${walletAddr.slice(0, 6)}…${walletAddr.slice(-4)}`
    : a.institution;
  const sublineFont = walletAddr ? "font-mono" : "";

  const patchName = usePatchAccountName();
  const saveName = async (next: string) => {
    const trimmed = next.trim();
    const value = trimmed === "" || trimmed === a.display_name ? null : trimmed;
    try {
      await patchName.mutateAsync({ accountId: a.id, override: value });
      setOverrideName(value);
    } finally {
      setEditingName(false);
    }
  };

  const onRowClick = () => {
    if (editingName) return;
    onSelect(a.id);
  };

  return (
    <li className={dimmed}>
      <div
        className={`flex items-center justify-between rounded px-2 py-2 transition-colors ${
          isSelected ? "bg-violet-50" : "hover:bg-stone-50"
        } ${editingName ? "" : "cursor-pointer"}`}
        onClick={onRowClick}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-3" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {editingName ? (
                <span
                  className="flex items-center gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="text"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") saveName(nameValue);
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    onBlur={() => saveName(nameValue)}
                    autoFocus
                    className="rounded border border-stone-300 px-1.5 py-0.5 text-sm outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-200"
                    placeholder={a.display_name}
                  />
                  <span
                    className="truncate text-xs text-stone-400"
                    title={`Original: ${a.display_name}`}
                  >
                    {a.display_name}
                  </span>
                </span>
              ) : (
                <span
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setNameValue(overrideName ?? "");
                    setEditingName(true);
                  }}
                  className="truncate text-sm font-medium text-stone-900"
                  title={
                    overrideName
                      ? `Double-click to rename · default: ${a.display_name}`
                      : "Double-click to rename"
                  }
                >
                  {displayName}
                </span>
              )}
              {isLive ? (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  live
                </span>
              ) : (
                <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                  manual
                </span>
              )}
              <AccountSyncIndicator accountId={a.id} mode={a.mode} />
            </div>
            <div className={`text-xs text-stone-500 ${sublineFont}`}>
              {subline}
              {!isLive && a.latest_as_of && (
                <span className="ml-1 text-stone-400">
                  · snapshot {formatDate(a.latest_as_of)}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="ml-4 text-right font-mono text-sm tabular-nums">
          {fmt.amount(a.latest_balance, { cents: true })}
        </div>
      </div>
      <AccountSyncLog accountId={a.id} />
    </li>
  );
}

/** Per-chain Zerion ids are ``zerion:<chain>:<address>``; the API
 * collapses them into synthetic ``wallet-group:<address>`` rows in
 * the Overview listing. Match both. */
export function walletAddressOf(accountId: string): string | null {
  if (accountId.startsWith("zerion:")) {
    const parts = accountId.split(":", 3);
    return parts.length === 3 ? parts[2].toLowerCase() : null;
  }
  if (accountId.startsWith("wallet-group:")) {
    return accountId.slice("wallet-group:".length).toLowerCase();
  }
  return null;
}

const BUNDLED_INSTITUTIONS = new Set([
  "Coinbase",
  "Kraken",
  "Gemini",
  "Binance",
]);

/** Render crypto accounts, aggregating per-chain Zerion accounts into
 * a single WalletRow per EVM address, and bundling known crypto-
 * exchange institutions under a single ExchangeRow. */
export function renderCryptoGrouped(
  accounts: Account[],
  selectedId: string | null,
  onSelect: (id: string) => void,
) {
  const grouped = new Map<string, Account[]>();
  const byInstitution = new Map<string, Account[]>();
  const ungrouped: Account[] = [];
  for (const a of accounts) {
    const addr = walletAddressOf(a.id);
    if (addr) {
      if (!grouped.has(addr)) grouped.set(addr, []);
      grouped.get(addr)!.push(a);
    } else if (BUNDLED_INSTITUTIONS.has(a.institution)) {
      if (!byInstitution.has(a.institution)) byInstitution.set(a.institution, []);
      byInstitution.get(a.institution)!.push(a);
    } else {
      ungrouped.push(a);
    }
  }
  const totalOf = (xs: Account[]) =>
    xs.reduce((s, x) => s + (x.latest_balance ?? 0), 0);
  const walletEntries = [...grouped.entries()].sort(
    (a, b) => totalOf(b[1]) - totalOf(a[1]),
  );
  const institutionEntries = [...byInstitution.entries()].sort(
    (a, b) => totalOf(b[1]) - totalOf(a[1]),
  );
  return [
    ...walletEntries.map(([addr, chains]) => (
      <WalletRow
        key={addr}
        address={addr}
        chains={chains}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    )),
    ...institutionEntries.map(([inst, subs]) => (
      <ExchangeRow
        key={inst}
        institution={inst}
        subs={subs}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    )),
    ...ungrouped.map((a) => (
      <AccountRow
        key={a.id}
        account={a}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    )),
  ];
}

export function ExchangeRow({
  institution,
  subs,
  selectedId,
  onSelect,
}: { institution: string; subs: Account[] } & RowSelection) {
  const fmt = usePrivateFormat();
  const total = subs.reduce((s, c) => s + (c.latest_balance ?? 0), 0);
  const key = `bundle:${institution}`;
  const isSelected = selectedId === key;
  return (
    <li>
      <div
        className={`flex cursor-pointer items-center justify-between rounded px-2 py-2 transition-colors ${
          isSelected ? "bg-violet-50" : "hover:bg-stone-50"
        }`}
        onClick={() => key && onSelect(key)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-3" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-stone-900">
                {institution}
              </span>
              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                live
              </span>
              <span className="text-[10px] text-stone-400">
                {subs.length} wallet{subs.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        </div>
        <div className="ml-4 text-right font-mono text-sm tabular-nums">
          {fmt.amount(total, { cents: true })}
        </div>
      </div>
    </li>
  );
}

export function WalletRow({
  address,
  chains,
  selectedId,
  onSelect,
}: { address: string; chains: Account[] } & RowSelection) {
  const fmt = usePrivateFormat();
  const patchName = usePatchAccountName();
  const total = chains.reduce((s, c) => s + (c.latest_balance ?? 0), 0);
  const sampleOverride = chains.find(
    (c) => c.display_name_override,
  )?.display_name_override;
  const initialNickname = sampleOverride
    ? sampleOverride.replace(/\s·\s.+$/, "")
    : `Wallet ${address.slice(0, 6)}…${address.slice(-4)}`;
  const [nickname, setNickname] = useState(initialNickname);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const walletKey = `wallet:${address}`;
  const isSelected = selectedId === walletKey;

  const saveNickname = async (next: string) => {
    const trimmed = next.trim();
    // Apply the new wallet nickname to every chain row as
    // "<nickname> · <Chain>" so each per-chain account inherits it.
    try {
      await Promise.all(
        chains.map((c) => {
          const override =
            trimmed === "" ? null : `${trimmed} · ${c.institution}`;
          return patchName.mutateAsync({
            accountId: c.id,
            override,
          });
        }),
      );
      setNickname(
        trimmed === ""
          ? `Wallet ${address.slice(0, 6)}…${address.slice(-4)}`
          : trimmed,
      );
    } finally {
      setEditing(false);
    }
  };

  return (
    <li>
      <div
        className={`flex items-center justify-between rounded px-2 py-2 transition-colors ${
          isSelected ? "bg-violet-50" : "hover:bg-stone-50"
        } ${editing ? "" : "cursor-pointer"}`}
        onClick={() => !editing && onSelect(walletKey)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-3" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {editing ? (
                <input
                  type="text"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") saveNickname(draft);
                    if (e.key === "Escape") setEditing(false);
                  }}
                  onBlur={() => saveNickname(draft)}
                  className="rounded border border-stone-300 px-1.5 py-0.5 text-sm outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-200"
                  placeholder="Wallet nickname"
                />
              ) : (
                <span
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setDraft(nickname);
                    setEditing(true);
                  }}
                  className="truncate text-sm font-medium text-stone-900"
                  title="Double-click to rename wallet"
                >
                  {nickname}
                </span>
              )}
              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                live
              </span>
              <span className="text-[10px] text-stone-400">
                {chains.length} chain{chains.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="font-mono text-[10px] text-stone-400">{short}</div>
          </div>
        </div>
        <div className="ml-4 text-right font-mono text-sm tabular-nums">
          {fmt.amount(total, { cents: true })}
        </div>
      </div>
    </li>
  );
}

export function ChainBreakdownBar({
  chains,
  total,
}: {
  chains: Account[];
  total: number;
}) {
  const fmt = usePrivateFormat();
  const COLORS = [
    "#10b981",
    "#f59e0b",
    "#0ea5e9",
    "#8b5cf6",
    "#f43f5e",
    "#14b8a6",
    "#ec4899",
    "#f97316",
  ];
  const sorted = [...chains].sort(
    (a, b) => (b.latest_balance ?? 0) - (a.latest_balance ?? 0),
  );
  return (
    <div className="pt-2">
      <div className="mb-1 flex items-baseline justify-between text-xs text-stone-500">
        <span>chains</span>
        <span className="font-mono tabular-nums">
          {fmt.amount(total, { cents: true })}
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-sm bg-stone-200">
        {sorted.map((c, i) => {
          const pct = total > 0 ? ((c.latest_balance ?? 0) / total) * 100 : 0;
          return (
            <div
              key={c.id}
              title={`${c.institution} · ${fmt.amount(c.latest_balance, { cents: true })} · ${pct.toFixed(1)}%`}
              style={{ width: `${pct}%`, backgroundColor: COLORS[i % COLORS.length] }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-stone-500">
        {sorted.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            {c.institution} · {fmt.amount(c.latest_balance, { cents: true })}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AggregatedHoldingsList({
  chains,
  total,
}: {
  chains: Account[];
  total: number;
}) {
  const fmt = usePrivateFormat();
  type Combined = {
    symbol: string;
    chain: string;
    value_usd: number;
    quantity: number | null;
  };
  const items: Combined[] = [];
  for (const c of chains) {
    for (const h of c.holdings ?? []) {
      items.push({
        symbol: h.symbol,
        chain: c.institution,
        value_usd: h.value_usd,
        quantity: h.quantity,
      });
    }
  }
  items.sort((a, b) => b.value_usd - a.value_usd);
  if (items.length === 0)
    return <div className="text-xs text-stone-400">no positions</div>;
  return (
    <ul>
      {items.map((it, i) => {
        const pct = total > 0 ? (it.value_usd / total) * 100 : 0;
        return (
          <li key={i} className="flex items-baseline gap-2 py-0.5 text-xs">
            <span className="w-16 truncate font-mono text-stone-700">
              {it.symbol}
            </span>
            <span className="w-16 truncate text-[10px] text-stone-400">
              {it.chain.toLowerCase()}
            </span>
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-sm bg-stone-200">
              <span
                className="absolute inset-y-0 left-0 bg-emerald-500"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="w-10 text-right tabular-nums text-stone-400">
              {formatPct(pct)}
            </span>
            <span className="w-20 text-right font-mono tabular-nums text-stone-700">
              {fmt.amount(it.value_usd, { cents: true })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

