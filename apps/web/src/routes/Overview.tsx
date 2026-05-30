import { useCallback, useMemo, useState } from "react";
import {
  ACCOUNT_TYPE_LABELS as TYPE_LABELS,
  ACCOUNT_TYPE_ORDER as TYPE_ORDER,
} from "../../../../packages/shared/types";
import type { Account } from "../lib/api";
import { formatDate } from "../lib/format";
import { LineChart, type Series } from "../lib/LineChart";
import { StackedSnapshotChart } from "../lib/StackedSnapshotChart";
import { usePrivacy, usePrivateFormat, privacyPoints, privacySnapshots } from "../lib/privacy";
import {
  useAccounts,
  useBundleHistory,
  useHoldingsHistory,
  useNetWorthBreakdown,
  useNetWorthSeries,
  useSummary,
  useSyncSimpleFIN,
  useSyncZerion,
  useSyncDefillama,
  useSyncAlchemy,
  useSyncGeckoterminal,
  useSyncCoinbase,
  useSyncAllSequential,
  useWalletHistory,
} from "../lib/queries";
import { useSyncRunning } from "../lib/syncStream";
import {
  AccountRow,
  renderCryptoGrouped,
  walletAddressOf,
} from "../components/overview/rows";
import { WalletComposition } from "../components/overview/WalletComposition";
import {
  ChartPlaceholder,
  GranularitySwitch,
  ModeSwitch,
  RangeSwitch,
  rangeStart,
  type ChartMode,
  type Granularity,
  type TimeRange,
} from "../components/overview/controls";
import { SyncDebugLog } from "../components/overview/SyncDebugLog";

const GRANULARITY_STORAGE_KEY = "finance.netWorthGranularity";
const MODE_STORAGE_KEY = "finance.netWorthMode";
const RANGE_STORAGE_KEY = "finance.netWorthRange";


export function Overview() {
  const fmt = usePrivateFormat();
  const { enabled: privacyOn } = usePrivacy();
  const summaryQ = useSummary();
  const accountsQ = useAccounts();
  const [granularity, setGranularityState] = useState<Granularity>(() => {
    if (typeof window === "undefined") return "week";
    const stored = window.localStorage.getItem(GRANULARITY_STORAGE_KEY);
    if (stored === "day" || stored === "week" || stored === "month" || stored === "year") {
      return stored;
    }
    return "week";
  });
  const [mode, setModeState] = useState<ChartMode>(() => {
    if (typeof window === "undefined") return "combined";
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === "split" || stored === "breakdown") return stored;
    return "combined";
  });
  const [range, setRangeState] = useState<TimeRange>(() => {
    if (typeof window === "undefined") return "6m";
    const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
    const valid: TimeRange[] = ["1m", "3m", "6m", "ytd", "1y", "all"];
    return (valid as string[]).includes(stored ?? "")
      ? (stored as TimeRange)
      : "6m";
  });
  const setGranularity = useCallback((next: Granularity) => {
    setGranularityState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(GRANULARITY_STORAGE_KEY, next);
    }
  }, []);
  const setMode = useCallback((next: ChartMode) => {
    setModeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    }
  }, []);
  const setRange = useCallback((next: TimeRange) => {
    setRangeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next);
    }
  }, []);
  const rangeStartDate = useMemo(() => rangeStart(range), [range]);

  // selectedId keys:
  //   null                 — Net worth (default)
  //   "<account_id>"       — a single account
  //   "wallet:<addr>"      — a Zerion wallet aggregated across chains
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedWalletAddr = selectedId?.startsWith("wallet:")
    ? selectedId.slice("wallet:".length)
    : null;
  const selectedBundleInst = selectedId?.startsWith("bundle:")
    ? selectedId.slice("bundle:".length)
    : null;
  const [showInactive, setShowInactive] = useState(false);
  const running = useSyncRunning();
  const seriesQ = useNetWorthSeries(granularity);
  const breakdownQ = useNetWorthBreakdown(
    granularity,
    mode === "breakdown" && !selectedId,
  );
  // 0 = full history. Per-account chart shows the same range the
  // net-worth chart aggregates from this account — no artificial cap.
  const accountQ = useHoldingsHistory(
    selectedWalletAddr || selectedBundleInst ? "" : selectedId ?? "",
    0,
  );
  const walletQ = useWalletHistory(selectedWalletAddr ?? "", 0);
  const bundleQ = useBundleHistory(selectedBundleInst ?? "", 0);
  const summary = summaryQ.data;
  const accounts = accountsQ.data;
  const points = seriesQ.data;
  const error = summaryQ.error ?? accountsQ.error ?? seriesQ.error;
  const selectedAccount = useMemo(
    () =>
      selectedId && !selectedWalletAddr && !selectedBundleInst
        ? accounts?.find((a) => a.id === selectedId) ?? null
        : null,
    [accounts, selectedId, selectedWalletAddr, selectedBundleInst],
  );
  const selectedBundle = useMemo(() => {
    if (!selectedBundleInst || !accounts) return null;
    const subs = accounts.filter(
      (a) =>
        a.active === 1 &&
        a.mode === "live" &&
        a.type === "crypto" &&
        a.institution === selectedBundleInst,
    );
    if (subs.length === 0) return null;
    const total = subs.reduce((s, c) => s + (c.latest_balance ?? 0), 0);
    const latest = subs
      .map((c) => c.latest_as_of)
      .filter(Boolean)
      .sort()
      .pop();
    return { subs, total, latest, nickname: selectedBundleInst };
  }, [accounts, selectedBundleInst]);
  // Aggregate wallet info for the header when a wallet is selected.
  const selectedWallet = useMemo(() => {
    if (!selectedWalletAddr || !accounts) return null;
    const chains = accounts.filter(
      (a) => walletAddressOf(a.id) === selectedWalletAddr,
    );
    if (chains.length === 0) return null;
    const total = chains.reduce((s, c) => s + (c.latest_balance ?? 0), 0);
    const sample = chains.find(
      (c) => c.display_name_override,
    )?.display_name_override;
    const nickname = sample
      ? sample.replace(/\s·\s.+$/, "")
      : `Wallet ${selectedWalletAddr.slice(0, 6)}…${selectedWalletAddr.slice(-4)}`;
    const latest = chains
      .map((c) => c.latest_as_of)
      .filter(Boolean)
      .sort()
      .pop();
    return { nickname, total, chains, latest };
  }, [accounts, selectedWalletAddr]);

  const syncSimpleFINMut = useSyncSimpleFIN();
  const syncZerionMut = useSyncZerion();
  const syncDefillamaMut = useSyncDefillama();
  const syncAlchemyMut = useSyncAlchemy();
  const syncGeckoterminalMut = useSyncGeckoterminal();
  const syncCoinbaseMut = useSyncCoinbase();
  const syncAllMut = useSyncAllSequential();

  const grouped = useMemo(() => {
    if (!accounts) return null;
    const filtered = accounts.filter((a) => showInactive || a.active === 1);
    const byType = new Map<Account["type"], Account[]>();
    for (const a of filtered) {
      if (!byType.has(a.type)) byType.set(a.type, []);
      byType.get(a.type)!.push(a);
    }
    return TYPE_ORDER.filter((t) => byType.has(t)).map((t) => ({
      type: t,
      accounts: byType.get(t)!,
    }));
  }, [accounts, showInactive]);

  // Apply the selected time range to every per-day data source. Each
  // chart variant filters the same way — snapshots with as_of/date on
  // or after rangeStartDate.
  const afterRange = <T extends { date?: string; as_of?: string }>(
    xs: T[] | undefined,
  ): T[] | undefined => {
    if (!xs || !rangeStartDate) return xs;
    return xs.filter((x) => (x.date ?? x.as_of ?? "") >= rangeStartDate);
  };
  // Sub-graphs (per-account / wallet / bundle) come back as daily
  // snapshots from the API; downsample client-side to whatever
  // granularity the user picked. Last snapshot per period wins,
  // matching the API's downsample logic for the network-worth series.
  const periodKey = (iso: string): string => {
    if (granularity === "day") return iso;
    if (granularity === "year") return iso.slice(0, 4);
    if (granularity === "month") return iso.slice(0, 7);
    // week: ISO week — use Date arithmetic
    const d = new Date(iso + "T00:00:00Z");
    const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const day = (d.getUTCDay() + 6) % 7; // Mon=0
    d.setUTCDate(d.getUTCDate() - day + 3);
    const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  };
  const downsample = <T extends { date?: string; as_of?: string }>(
    xs: T[] | undefined,
  ): T[] | undefined => {
    if (!xs || granularity === "day") return xs;
    const last = new Map<string, T>();
    for (const x of xs) last.set(periodKey(x.date ?? x.as_of ?? ""), x);
    return [...last.values()];
  };

  const filteredPoints = afterRange(points);
  const filteredAccountSnaps = downsample(afterRange(accountQ.data?.snapshots));
  const filteredWalletSnaps = downsample(afterRange(walletQ.data?.snapshots));
  const filteredBundleSnaps = downsample(afterRange(bundleQ.data?.snapshots));
  const filteredBreakdownSnaps = afterRange(breakdownQ.data?.snapshots);

  const privateBundleSnaps = useMemo(
    () => privacyOn && filteredBundleSnaps ? privacySnapshots(filteredBundleSnaps, "bundle") : filteredBundleSnaps,
    [filteredBundleSnaps, privacyOn],
  );
  const privateWalletSnaps = useMemo(
    () => privacyOn && filteredWalletSnaps ? privacySnapshots(filteredWalletSnaps, "wallet") : filteredWalletSnaps,
    [filteredWalletSnaps, privacyOn],
  );
  const privateAccountSnaps = useMemo(
    () => privacyOn && filteredAccountSnaps ? privacySnapshots(filteredAccountSnaps, "account_stacked") : filteredAccountSnaps,
    [filteredAccountSnaps, privacyOn],
  );
  const privateBreakdownSnaps = useMemo(
    () => privacyOn && filteredBreakdownSnaps ? privacySnapshots(filteredBreakdownSnaps, "breakdown") : filteredBreakdownSnaps,
    [filteredBreakdownSnaps, privacyOn],
  );

  const accountSeries: Series[] = useMemo(() => {
    const snaps = filteredAccountSnaps;
    if (!snaps || snaps.length === 0) return [];
    return [
      {
        key: "total",
        label: selectedAccount?.display_name_override ??
          selectedAccount?.display_name ??
          "Account",
        colorClass: "text-violet-500",
        areaBaseline: "bottom",
        points: privacyOn
          ? privacyPoints(snaps.map((s) => ({ x: s.as_of, y: s.total })), "account")
          : snaps.map((s) => ({ x: s.as_of, y: s.total })),
      },
    ];
  }, [filteredAccountSnaps, selectedAccount, privacyOn]);

  const series: Series[] = useMemo(() => {
    const points = filteredPoints;
    if (!points || points.length === 0) return [];
    if (mode === "combined") {
      return [
        {
          key: "net_worth",
          label: "Net worth",
          colorClass: "text-emerald-500",
          areaBaseline: "bottom",
          points: privacyOn
            ? privacyPoints(points.map((p) => ({ x: p.date, y: p.net_worth })), "net_worth")
            : points.map((p) => ({ x: p.date, y: p.net_worth })),
        },
      ];
    }
    return [
      {
        key: "net_worth",
        label: "Net worth",
        colorClass: "text-rose-500",
        areaColorClass: "text-emerald-500",
        areaBaseline: "bottom",
        points: privacyOn
          ? privacyPoints(points.map((p) => ({ x: p.date, y: p.net_worth })), "net_worth")
          : points.map((p) => ({ x: p.date, y: p.net_worth })),
      },
      {
        key: "assets",
        label: "Assets",
        colorClass: "text-emerald-500",
        areaColorClass: "text-rose-500",
        areaBetween: "net_worth",
        points: privacyOn
          ? privacyPoints(points.map((p) => ({ x: p.date, y: p.total_assets })), "assets")
          : points.map((p) => ({ x: p.date, y: p.total_assets })),
      },
      {
        key: "debts",
        label: "Debt",
        colorClass: "text-rose-500",
        hidden: true,
        points: privacyOn
          ? privacyPoints(points.map((p) => ({ x: p.date, y: p.total_debts })), "debts")
          : points.map((p) => ({ x: p.date, y: p.total_debts })),
      },
    ];
  }, [filteredPoints, mode, privacyOn]);

  const handleRowSelect = (id: string) =>
    setSelectedId((cur) => (cur === id ? null : id));

  if (error) {
    return <pre className="text-red-700">{String(error)}</pre>;
  }
  if (!summary || !grouped || !accounts) {
    return <p className="text-stone-500">loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 max-w-5xl flex-col">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-stone-300"
            />
            show inactive
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="sync-all-btn"
              onClick={() => syncAllMut.mutate()}
              disabled={running}
              className="flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Pull latest data from every parser, sequentially"
            >
              <span
                className={running ? "inline-block animate-spin" : "inline-block"}
              >
                ⟳
              </span>
              {running ? "syncing…" : "sync all"}
            </button>
            <button
              type="button"
              data-testid="sync-simplefin-btn"
              onClick={() => syncSimpleFINMut.mutate(365)}
              disabled={running}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-500 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Sync SimpleFIN only (banks, cards)"
            >
              bank
            </button>
            <button
              type="button"
              data-testid="sync-zerion-btn"
              onClick={() => syncZerionMut.mutate()}
              disabled={running}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-500 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Sync Zerion only (crypto wallets)"
            >
              crypto
            </button>
            <button
              type="button"
              data-testid="sync-defillama-btn"
              onClick={() => syncDefillamaMut.mutate()}
              disabled={running}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-500 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Sync DefiLlama prices for tracked crypto positions"
            >
              defi
            </button>
            <button
              type="button"
              data-testid="sync-alchemy-btn"
              onClick={() => syncAlchemyMut.mutate()}
              disabled={running}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-500 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Sync Alchemy on-chain balances"
            >
              evm
            </button>
            <button
              type="button"
              data-testid="sync-geckoterminal-btn"
              onClick={() => syncGeckoterminalMut.mutate()}
              disabled={running}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-500 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Sync GeckoTerminal pool prices"
            >
              gecko
            </button>
            <button
              type="button"
              data-testid="sync-coinbase-btn"
              onClick={() => syncCoinbaseMut.mutate()}
              disabled={running}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-500 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Sync Coinbase exchange balances"
            >
              coinbase
            </button>
          </div>
        </div>
      </header>

      <SyncDebugLog />

      <section className="mb-6 rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <div>
            <div data-testid="net-worth-label" className="text-xs font-medium uppercase tracking-wider text-stone-500">
              {selectedBundle
                ? selectedBundle.nickname
                : selectedWallet
                ? selectedWallet.nickname
                : selectedAccount
                ? selectedAccount.display_name_override ??
                  selectedAccount.display_name
                : "Net worth"}
            </div>
            <div data-testid="net-worth-value" className="mt-1 font-mono text-4xl font-semibold tabular-nums text-stone-900">
              {fmt.amount(
                selectedBundle
                  ? selectedBundle.total
                  : selectedWallet
                  ? selectedWallet.total
                  : selectedAccount
                  ? selectedAccount.latest_balance ?? 0
                  : summary.net_worth,
              )}
            </div>
            <div className="mt-1 text-xs text-stone-400">
              {selectedBundle ? (
                <>
                  {selectedBundle.subs.length} wallet
                  {selectedBundle.subs.length === 1 ? "" : "s"}
                  {selectedBundle.latest && (
                    <> · as of {formatDate(selectedBundle.latest)}</>
                  )}
                </>
              ) : selectedWallet ? (
                <>
                  {selectedWallet.chains.length} chain
                  {selectedWallet.chains.length === 1 ? "" : "s"}
                  {selectedWallet.latest && (
                    <> · as of {formatDate(selectedWallet.latest)}</>
                  )}
                </>
              ) : selectedAccount ? (
                <>
                  {selectedAccount.institution}
                  {selectedAccount.latest_as_of && (
                    <> · as of {formatDate(selectedAccount.latest_as_of)}</>
                  )}
                </>
              ) : (
                <>
                  as of {formatDate(summary.as_of)} ·{" "}
                  {summary.counts.active_accounts} of {summary.counts.accounts}{" "}
                  accounts
                </>
              )}
            </div>
          </div>
          {!selectedAccount && !selectedWallet && !selectedBundle && (
            <div className="hidden gap-6 md:flex">
              <div className="text-right">
                <div className="text-xs font-medium uppercase tracking-wider text-stone-500">
                  Assets
                </div>
                <div className="font-mono text-xl font-semibold tabular-nums text-emerald-700">
                  {fmt.amount(summary.total_assets)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-medium uppercase tracking-wider text-stone-500">
                  Debts
                </div>
                <div className="font-mono text-xl font-semibold tabular-nums text-rose-700">
                  {fmt.amount(summary.total_debts)}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 border-t border-stone-100 pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              History
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <RangeSwitch value={range} onChange={setRange} />
              {/* ModeSwitch (Net/Split/Breakdown) only makes sense at the
                  portfolio level. Granularity applies to all charts. */}
              {!selectedAccount && !selectedWallet && !selectedBundle && (
                <ModeSwitch value={mode} onChange={setMode} />
              )}
              <GranularitySwitch
                value={granularity}
                onChange={setGranularity}
              />
            </div>
          </div>
          <div
            className="relative"
            style={{ minHeight: mode === "split" && !selectedAccount && !selectedWallet ? 320 : 260 }}
          >
            {selectedBundle ? (
              bundleQ.isLoading || !filteredBundleSnaps ? (
                <ChartPlaceholder height={260} label="loading chart…" />
              ) : filteredBundleSnaps.length === 0 ? (
                <ChartPlaceholder
                  height={260}
                  label="No history in this time range."
                />
              ) : (
                <StackedSnapshotChart
                  snapshots={privateBundleSnaps!}
                  width={720}
                  height={260}
                />
              )
            ) : selectedWallet ? (
              walletQ.isLoading || !filteredWalletSnaps ? (
                <ChartPlaceholder height={260} label="loading chart…" />
              ) : filteredWalletSnaps.length === 0 ? (
                <ChartPlaceholder
                  height={260}
                  label="No history in this time range."
                />
              ) : (
                <StackedSnapshotChart
                  snapshots={privateWalletSnaps!}
                  width={720}
                  height={260}
                />
              )
            ) : selectedAccount ? (
              accountQ.isLoading || !filteredAccountSnaps ? (
                <ChartPlaceholder height={260} label="loading chart…" />
              ) : filteredAccountSnaps.length === 0 ? (
                <ChartPlaceholder
                  height={260}
                  label="No history in this time range."
                />
              ) : filteredAccountSnaps.some((s) => s.holdings.length > 0) ? (
                <StackedSnapshotChart
                  snapshots={privateAccountSnaps!}
                  width={720}
                  height={260}
                />
              ) : (
                <LineChart
                  series={accountSeries}
                  width={720}
                  height={260}
                  formatY={(n) => fmt.amount(n)}
                />
              )
            ) : mode === "breakdown" ? (
              breakdownQ.isLoading || !filteredBreakdownSnaps ? (
                <ChartPlaceholder height={260} label="loading chart…" />
              ) : filteredBreakdownSnaps.length === 0 ? (
                <ChartPlaceholder
                  height={260}
                  label="No history in this time range."
                />
              ) : (
                <StackedSnapshotChart
                  snapshots={privateBreakdownSnaps!}
                  width={720}
                  height={260}
                  maxSeries={30}
                />
              )
            ) : !filteredPoints ? (
              <ChartPlaceholder
                height={mode === "split" ? 320 : 260}
                label="loading chart…"
              />
            ) : filteredPoints.length === 0 ? (
              <ChartPlaceholder
                height={mode === "split" ? 320 : 260}
                label="No history in this time range."
              />
            ) : (
              <LineChart
                series={series}
                width={720}
                height={mode === "split" ? 320 : 260}
                formatY={(n) => fmt.amount(n)}
              />
            )}
          </div>
          {(() => {
            // Composition panel appears for any Zerion wallet — whether
            // selected via the multi-chain bundle (walletKey) or via a
            // single-chain account row (a single zerion:<chain>:<addr>).
            const addr =
              selectedWalletAddr ??
              (selectedAccount && walletAddressOf(selectedAccount.id)) ??
              null;
            return addr ? <WalletComposition address={addr} /> : null;
          })()}
        </div>
      </section>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-2">
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className={`flex w-full items-center justify-between rounded px-2 py-2 text-left transition-colors ${
            selectedId == null
              ? "bg-violet-50 text-violet-900"
              : "hover:bg-stone-50"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="w-3" />
            <span className="text-sm font-semibold text-stone-900">
              Net worth
            </span>
            <span className="text-[10px] text-stone-400">
              {summary.counts.active_accounts} accounts
            </span>
          </div>
          <span className="font-mono text-sm tabular-nums text-stone-700">
            {fmt.amount(summary.net_worth)}
          </span>
        </button>
        {grouped.map(({ type, accounts: group }) => {
          const subtotal = group.reduce(
            (sum, a) => sum + (a.latest_balance ?? 0),
            0,
          );
          return (
            <section key={type}>
              <div className="mb-2 flex items-baseline justify-between border-b border-stone-200 pb-1">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
                  {TYPE_LABELS[type]}
                </h2>
                <span className="font-mono text-sm tabular-nums text-stone-500">
                  {fmt.amount(subtotal)}
                </span>
              </div>
              <ul className="divide-y divide-stone-100">
                {type === "crypto"
                  ? renderCryptoGrouped(group, selectedId, handleRowSelect)
                  : group.map((a) => (
                      <AccountRow
                        key={a.id}
                        account={a}
                        selectedId={selectedId}
                        onSelect={handleRowSelect}
                      />
                    ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

