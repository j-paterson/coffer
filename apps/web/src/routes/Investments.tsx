import { Fragment, useCallback, useMemo, useState } from "react";
import { LineChart, type Series } from "../lib/LineChart";
import { usePrivacy, usePrivateFormat, privacyPoints } from "../lib/privacy";
import { formatDate, formatPct, formatQty, formatUsd } from "../lib/format";
import {
  useBasisOverrides,
  useDeleteBasisOverride,
  useInvestmentsDefiBreakdown,
  useInvestmentsFlows,
  useInvestmentsHoldings,
  useInvestmentsRealizedSeries,
  useInvestmentsSeries,
  useInvestmentsTrades,
  useUpsertBasisOverride,
} from "../lib/queries";
import {
  ChartPlaceholder,
  GranularitySwitch,
  RangeSwitch,
  rangeStart,
  type Granularity,
  type TimeRange,
} from "../components/overview/controls";

const GRANULARITY_KEY = "finance.investmentsGranularity";
const RANGE_KEY = "finance.investmentsRange";

export function Investments() {
  const fmt = usePrivateFormat();
  const { enabled: privacyOn } = usePrivacy();

  const [granularity, setGranularityState] = useState<Granularity>(() => {
    const stored = window.localStorage.getItem(GRANULARITY_KEY);
    if (
      stored === "day" ||
      stored === "week" ||
      stored === "month" ||
      stored === "year"
    )
      return stored;
    return "month";
  });
  const [range, setRangeState] = useState<TimeRange>(() => {
    const stored = window.localStorage.getItem(RANGE_KEY);
    const valid: TimeRange[] = ["1m", "3m", "6m", "ytd", "1y", "all"];
    return (valid as string[]).includes(stored ?? "")
      ? (stored as TimeRange)
      : "all";
  });
  const setGranularity = useCallback((next: Granularity) => {
    setGranularityState(next);
    window.localStorage.setItem(GRANULARITY_KEY, next);
  }, []);
  const setRange = useCallback((next: TimeRange) => {
    setRangeState(next);
    window.localStorage.setItem(RANGE_KEY, next);
  }, []);

  const rangeStartDate = useMemo(() => rangeStart(range), [range]);

  const seriesQ = useInvestmentsSeries(granularity);
  const flowsQ = useInvestmentsFlows();
  const realizedQ = useInvestmentsRealizedSeries(granularity);
  const tradesQ = useInvestmentsTrades();
  const holdingsQ = useInvestmentsHoldings();
  const defiQ = useInvestmentsDefiBreakdown();
  const overridesQ = useBasisOverrides();
  const upsertOverride = useUpsertBasisOverride();
  const deleteOverride = useDeleteBasisOverride();
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());
  const [expandedPositions, setExpandedPositions] = useState<Set<string>>(
    new Set(),
  );
  const [showClosed, setShowClosed] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editCost, setEditCost] = useState("");

  const overridesBySymbol = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of overridesQ.data ?? []) {
      if (o.account_id == null) m.set(o.symbol.toUpperCase(), o.id);
    }
    return m;
  }, [overridesQ.data]);

  const filtered = useMemo(() => {
    const raw = seriesQ.data?.series;
    if (!raw) return undefined;
    if (!rangeStartDate) return raw;
    return raw.filter((p) => p.date >= rangeStartDate);
  }, [seriesQ.data, rangeStartDate]);

  const filteredFlows = useMemo(() => {
    const raw = flowsQ.data;
    if (!raw) return undefined;
    if (!rangeStartDate) return raw;
    return raw.filter((f) => f.date >= rangeStartDate);
  }, [flowsQ.data, rangeStartDate]);

  const filteredRealized = useMemo(() => {
    const raw = realizedQ.data?.series;
    if (!raw) return undefined;
    if (!rangeStartDate) return raw;
    return raw.filter((p) => p.date >= rangeStartDate);
  }, [realizedQ.data, rangeStartDate]);

  const filteredTrades = useMemo(() => {
    const raw = tradesQ.data;
    if (!raw) return undefined;
    if (!rangeStartDate) return raw;
    return raw.filter((t) => t.date >= rangeStartDate);
  }, [tradesQ.data, rangeStartDate]);

  const latest = filtered?.[filtered.length - 1];
  const holdingsTotals = holdingsQ.data?.totals;
  const portfolioValue = latest?.portfolio_value ?? 0;
  const costBasis = holdingsTotals?.cost_basis ?? 0;
  const unrealizedGain = holdingsTotals?.unrealized_pnl ?? null;
  const unrealizedPct =
    unrealizedGain != null && costBasis > 0
      ? (unrealizedGain / costBasis) * 100
      : null;
  const realizedTotal = holdingsTotals?.realized_pnl ?? null;
  const manualAdjustments = holdingsTotals?.manual_adjustments ?? 0;

  const portfolioSeries: Series[] = useMemo(() => {
    if (!filtered || filtered.length === 0) return [];
    return [
      {
        key: "portfolio_value",
        label: "Portfolio value",
        colorClass: "text-emerald-500",
        areaBaseline: "bottom" as const,
        points: privacyOn
          ? privacyPoints(filtered.map((p) => ({ x: p.date, y: p.portfolio_value })), "portfolio_value")
          : filtered.map((p) => ({ x: p.date, y: p.portfolio_value })),
      },
    ];
  }, [filtered, privacyOn]);

  const realizedSeries: Series[] = useMemo(() => {
    if (!filteredRealized || filteredRealized.length === 0) return [];
    return [
      {
        key: "cumulative",
        label: "Cumulative P&L",
        colorClass: "text-violet-500",
        areaBaseline: "zero" as const,
        cumulative: true,
        points: privacyOn
          ? privacyPoints(
              filteredRealized.map((p) => ({
                x: p.date,
                y: p.cumulative,
                xStart: p.bucket_start,
                xEnd: p.bucket_end,
              })),
              "realized_cumulative",
            )
          : filteredRealized.map((p) => ({
              x: p.date,
              y: p.cumulative,
              xStart: p.bucket_start,
              xEnd: p.bucket_end,
            })),
      },
      {
        key: "period",
        label: "Period P&L",
        colorClass: "text-amber-500",
        areaBaseline: "none" as const,
        hidden: true,
        points: privacyOn
          ? privacyPoints(
              filteredRealized.map((p) => ({
                x: p.date,
                y: p.realized,
                xStart: p.bucket_start,
                xEnd: p.bucket_end,
              })),
              "realized_period",
            )
          : filteredRealized.map((p) => ({
              x: p.date,
              y: p.realized,
              xStart: p.bucket_start,
              xEnd: p.bucket_end,
            })),
      },
    ];
  }, [filteredRealized, privacyOn]);

  const [pnlRange, setPnlRange] = useState<{
    startDate: string;
    endDate: string;
  } | null>(null);

  const pnlBreakdown = useMemo(() => {
    if (!pnlRange || !tradesQ.data) return null;
    const inRange = tradesQ.data.filter(
      (t) =>
        t.date >= pnlRange.startDate &&
        t.date <= pnlRange.endDate &&
        t.realized_pnl !== 0,
    );
    inRange.sort((a, b) => Math.abs(b.realized_pnl) - Math.abs(a.realized_pnl));
    const totalPnl = inRange.reduce((s, t) => s + t.realized_pnl, 0);
    return { trades: inRange.slice(0, 15), total: totalPnl, count: inRange.length };
  }, [pnlRange, tradesQ.data]);

  const tradesBySymbol = useMemo(() => {
    type T = NonNullable<typeof tradesQ.data>[number];
    const out = new Map<string, T[]>();
    if (!tradesQ.data) return out;
    for (const t of tradesQ.data) {
      const keys = new Set<string>();
      if (t.canonical_sent) keys.add(t.canonical_sent);
      if (t.canonical_recv) keys.add(t.canonical_recv);
      for (const k of keys) {
        const arr = out.get(k);
        if (arr) arr.push(t);
        else out.set(k, [t]);
      }
    }
    return out;
  }, [tradesQ.data]);

  const tradeTypes = useMemo(() => {
    if (!filteredTrades) return [];
    const types = new Set(filteredTrades.map((t) => t.type));
    return ["ALL", ...Array.from(types).sort()];
  }, [filteredTrades]);
  const [tradesFilter, setTradesFilter] = useState("ALL");
  const visibleTrades = useMemo(() => {
    if (!filteredTrades) return undefined;
    if (tradesFilter === "ALL") return filteredTrades;
    return filteredTrades.filter((t) => t.type === tradesFilter);
  }, [filteredTrades, tradesFilter]);

  const error =
    seriesQ.error ??
    flowsQ.error ??
    realizedQ.error ??
    tradesQ.error ??
    holdingsQ.error;
  if (error) {
    return <pre className="text-red-700">{String(error)}</pre>;
  }

  return (
    <div className="flex h-full min-h-0 max-w-5xl flex-col">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Investments</h1>
      </header>

      {/* Portfolio value + cost basis header */}
      <section className="mb-6 rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-stone-500">
              Portfolio value
            </div>
            <div className="mt-1 font-mono text-4xl font-semibold tabular-nums text-stone-900">
              {latest ? fmt.amount(portfolioValue) : "—"}
            </div>
          </div>
          <div className="hidden gap-6 md:flex">
            <div className="text-right">
              <div className="text-xs font-medium uppercase tracking-wider text-stone-500">
                Cost basis
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-stone-600">
                {holdingsTotals ? fmt.amount(costBasis) : "—"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs font-medium uppercase tracking-wider text-stone-500">
                Unrealized
              </div>
              <div
                className={`font-mono text-xl font-semibold tabular-nums ${
                  unrealizedGain != null && unrealizedGain >= 0
                    ? "text-emerald-700"
                    : "text-rose-700"
                }`}
              >
                {unrealizedGain != null ? fmt.amount(unrealizedGain) : "—"}
                {unrealizedPct != null && (
                  <span className="ml-1 text-sm">
                    ({unrealizedPct >= 0 ? "+" : ""}
                    {formatPct(unrealizedPct)})
                  </span>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs font-medium uppercase tracking-wider text-stone-500">
                Realized
              </div>
              <div
                className={`font-mono text-xl font-semibold tabular-nums ${
                  realizedTotal != null && realizedTotal >= 0
                    ? "text-emerald-700"
                    : "text-rose-700"
                }`}
              >
                {realizedTotal != null ? fmt.amount(realizedTotal) : "—"}
              </div>
              {manualAdjustments !== 0 && (
                <div
                  className="text-xs text-stone-400"
                  title="Manual realized losses not tied to a specific symbol (e.g. off-exchange or perps write-downs). Included in Realized."
                >
                  incl. {formatUsd(manualAdjustments)} manual
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Portfolio value chart */}
        <div className="mt-5 border-t border-stone-100 pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Portfolio value
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <RangeSwitch value={range} onChange={setRange} />
              <GranularitySwitch
                value={granularity}
                onChange={setGranularity}
              />
            </div>
          </div>
          <div className="relative" style={{ minHeight: 260 }}>
            {seriesQ.isLoading || !filtered ? (
              <ChartPlaceholder height={260} label="loading chart…" />
            ) : filtered.length === 0 ? (
              <ChartPlaceholder
                height={260}
                label="No investment data in this time range."
              />
            ) : (
              <LineChart
                series={portfolioSeries}
                width={720}
                height={260}
                formatY={(n) => fmt.amount(n)}
              />
            )}
          </div>
        </div>
      </section>

      {/* Realized P&L chart */}
      <section className="mb-6 rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Realized P&L
            </div>
            {filteredRealized && filteredRealized.length > 0 && (
              <div
                className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${
                  filteredRealized[filteredRealized.length - 1].cumulative >= 0
                    ? "text-emerald-700"
                    : "text-rose-700"
                }`}
              >
                {fmt.amount(
                  filteredRealized[filteredRealized.length - 1].cumulative,
                )}
              </div>
            )}
          </div>
        </div>
        <div className="relative" style={{ minHeight: 220 }}>
          {realizedQ.isLoading || !filteredRealized ? (
            <ChartPlaceholder height={220} label="loading chart…" />
          ) : filteredRealized.length === 0 ? (
            <ChartPlaceholder
              height={220}
              label="No realized gains in this time range."
            />
          ) : (
            <LineChart
              series={realizedSeries}
              width={720}
              height={220}
              formatY={(n) => fmt.amount(n)}
              onRangeSelect={setPnlRange}
            />
          )}
        </div>

        {/* P&L breakdown for selected range */}
        {pnlBreakdown && (
          <div className="mt-4 border-t border-stone-100 pt-4">
            <div className="mb-2 flex items-baseline justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                Top trades {pnlRange && (
                  <span className="font-normal normal-case text-stone-400">
                    {formatDate(pnlRange.startDate)} – {formatDate(pnlRange.endDate)}
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-xs text-stone-400">
                  {pnlBreakdown.count} trades with P&L
                </span>
                <span
                  className={`font-mono text-sm font-semibold tabular-nums ${
                    pnlBreakdown.total >= 0
                      ? "text-emerald-700"
                      : "text-rose-700"
                  }`}
                >
                  {pnlBreakdown.total >= 0 ? "+" : ""}
                  {formatUsd(pnlBreakdown.total)}
                </span>
              </div>
            </div>
            {pnlBreakdown.trades.length === 0 ? (
              <p className="py-4 text-sm text-stone-500">
                No trades with realized P&L in this range.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wider text-stone-500">
                    <th className="py-1.5 pr-4 font-medium">Date</th>
                    <th className="py-1.5 pr-4 font-medium">Type</th>
                    <th className="py-1.5 pr-4 font-medium">Trade</th>
                    <th className="py-1.5 pr-4 text-right font-medium">Cost basis</th>
                    <th className="py-1.5 text-right font-medium">P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-50">
                  {pnlBreakdown.trades.map((t, i) => {
                    const fmtQty = (n: number) =>
                      n < 1
                        ? n.toFixed(4)
                        : n.toLocaleString("en-US", {
                            maximumFractionDigits: 2,
                          });
                    return (
                      <tr key={i}>
                        <td className="whitespace-nowrap py-1.5 pr-4 text-stone-600">
                          {formatDate(t.date)}
                        </td>
                        <td className="py-1.5 pr-4">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                              t.type === "BUY"
                                ? "bg-emerald-50 text-emerald-700"
                                : t.type === "SELL"
                                  ? "bg-rose-50 text-rose-700"
                                  : t.type === "TRADE"
                                    ? "bg-violet-50 text-violet-700"
                                    : t.type === "LOSS"
                                      ? "bg-red-50 text-red-700"
                                      : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {t.type}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 text-stone-800">
                          <div className="flex items-baseline gap-1">
                            {t.sent_currency && t.sent_qty > 0 && (
                              <div>
                                <div>
                                  {fmtQty(t.sent_qty)} {t.sent_currency}
                                </div>
                                {t.sent_currency !== "USD" && t.sent_basis > 0 && (
                                  <div className="text-xs text-stone-400">
                                    {formatUsd(t.sent_basis)}
                                  </div>
                                )}
                              </div>
                            )}
                            {t.sent_currency && t.recv_currency && (
                              <span className="text-stone-400"> → </span>
                            )}
                            {t.recv_currency && t.recv_qty > 0 && (
                              <div>
                                <div>
                                  {fmtQty(t.recv_qty)} {t.recv_currency}
                                </div>
                                {t.recv_currency !== "USD" && t.recv_basis > 0 && (
                                  <div className="text-xs text-stone-400">
                                    {formatUsd(t.recv_basis)}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap py-1.5 pr-4 text-right font-mono tabular-nums text-stone-500">
                          {t.sent_basis > 0
                            ? formatUsd(t.sent_basis)
                            : "—"}
                        </td>
                        <td
                          className={`whitespace-nowrap py-1.5 text-right font-mono tabular-nums ${
                            t.realized_pnl >= 0
                              ? "text-emerald-700"
                              : "text-rose-700"
                          }`}
                        >
                          {t.realized_pnl >= 0 ? "+" : ""}
                          {formatUsd(t.realized_pnl)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* Positions — live holdings + closed positions with realized history.
          Expanding a row reveals every trade on that canonical symbol. */}
      {holdingsQ.data && holdingsQ.data.holdings.length > 0 && (
        <section className="mb-6 rounded-lg border border-stone-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
              Positions
              {(() => {
                const closedCount = holdingsQ.data!.holdings.filter(
                  (h) => h.closed,
                ).length;
                const liveCount = holdingsQ.data!.holdings.length - closedCount;
                return (
                  <span className="ml-2 text-xs font-normal normal-case text-stone-400">
                    {liveCount} live
                    {closedCount > 0 && ` · ${closedCount} closed`}
                  </span>
                );
              })()}
            </h2>
            <div className="flex items-center gap-4 text-xs">
              {holdingsQ.data.holdings.some((h) => h.closed) && (
                <label className="flex cursor-pointer items-center gap-1.5 text-stone-500">
                  <input
                    type="checkbox"
                    checked={showClosed}
                    onChange={(e) => setShowClosed(e.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer"
                  />
                  <span>Show closed</span>
                </label>
              )}
              <span className="text-stone-500">
                Value:{" "}
                <span className="font-mono font-semibold text-stone-800">
                  {fmt.amount(holdingsQ.data.totals.value)}
                </span>
              </span>
              <span className="text-stone-500">
                Basis:{" "}
                <span className="font-mono font-semibold text-stone-600">
                  {fmt.amount(holdingsQ.data.totals.cost_basis)}
                </span>
              </span>
              <span
                className={`font-mono font-semibold ${
                  holdingsQ.data.totals.unrealized_pnl >= 0
                    ? "text-emerald-700"
                    : "text-rose-700"
                }`}
                title="Unrealized P&L on current positions"
              >
                {holdingsQ.data.totals.unrealized_pnl >= 0 ? "+" : ""}
                {formatUsd(holdingsQ.data.totals.unrealized_pnl)}
              </span>
              <span
                className={`font-mono font-semibold ${
                  holdingsQ.data.totals.realized_pnl >= 0
                    ? "text-emerald-700"
                    : "text-rose-700"
                }`}
                title="Lifetime realized P&L from manual write-downs"
              >
                {holdingsQ.data.totals.realized_pnl >= 0 ? "+" : ""}
                {formatUsd(holdingsQ.data.totals.realized_pnl)} realized
              </span>
            </div>
          </div>
          <div className="max-h-[40rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="sticky top-0 border-b border-stone-100 bg-white text-left text-xs uppercase tracking-wider text-stone-500">
                  <th className="w-8 py-2 pl-6 pr-0" />
                  <th className="px-4 py-2 font-medium">Asset</th>
                  <th className="px-4 py-2 text-right font-medium">Qty</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 text-right font-medium">
                    Cost basis
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    Unrealized
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    Realized
                  </th>
                  <th className="px-4 py-2 pr-6 text-right font-medium">
                    Total return
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-50">
                {holdingsQ.data.holdings
                  .filter((h) => !h.closed || showClosed)
                  .map((h) => {
                    const pnlPct =
                      h.cost_basis != null && h.cost_basis > 0
                        ? ((h.unrealized_pnl ?? 0) / h.cost_basis) * 100
                        : null;
                    const rowKey = `${h.symbol}-${h.type}-${h.account_name ?? ""}`;
                    const isEditing = editingKey === rowKey;
                    const canEdit = h.type === "crypto" && !h.closed;
                    const overrideId = overridesBySymbol.get(h.symbol);
                    const sourceBadge =
                      h.basis_source === "manual"
                        ? { label: "manual", cls: "text-sky-600" }
                        : h.basis_source === "stablecoin"
                          ? { label: "stable", cls: "text-stone-400" }
                          : h.basis_source === "simplefin"
                            ? { label: "SimpleFIN", cls: "text-stone-400" }
                            : null;
                    const symbolTrades = tradesBySymbol.get(h.symbol) ?? [];
                    const hasTrades = symbolTrades.length > 0;
                    const isExpanded = expandedPositions.has(rowKey);
                    const totalReturn =
                      (h.unrealized_pnl ?? 0) + (h.realized_pnl ?? 0);
                    const hasReturnData =
                      h.unrealized_pnl != null || h.realized_pnl != null;
                    const rowDim = h.closed ? "text-stone-500" : "";
                    return (
                      <Fragment key={rowKey}>
                        <tr className="hover:bg-stone-50">
                          <td className="py-2 pl-6 pr-0">
                            {hasTrades ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedPositions((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(rowKey)) next.delete(rowKey);
                                    else next.add(rowKey);
                                    return next;
                                  })
                                }
                                className="flex h-5 w-5 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                                title={`${symbolTrades.length} trades`}
                              >
                                {isExpanded ? "▾" : "▸"}
                              </button>
                            ) : null}
                          </td>
                          <td className={`px-4 py-2 ${rowDim}`}>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{h.symbol}</span>
                              {h.closed && (
                                <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                                  closed
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-stone-400">
                              {h.account_name ?? h.type}
                            </div>
                          </td>
                          <td
                            className={`whitespace-nowrap px-4 py-2 text-right font-mono tabular-nums ${
                              h.closed ? "text-stone-300" : "text-stone-600"
                            }`}
                          >
                            {h.closed ? "—" : formatQty(h.quantity)}
                          </td>
                          <td
                            className={`whitespace-nowrap px-4 py-2 text-right font-mono tabular-nums ${
                              h.closed ? "text-stone-300" : "text-stone-800"
                            }`}
                          >
                            {h.closed ? "—" : fmt.amount(h.value_usd)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-right font-mono tabular-nums text-stone-500">
                            {isEditing ? (
                              <form
                                className="flex items-center justify-end gap-1"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  const cost = Number(editCost);
                                  if (!Number.isFinite(cost) || cost < 0) return;
                                  upsertOverride.mutate(
                                    {
                                      symbol: h.symbol,
                                      cost_usd: cost,
                                      quantity_at_entry: h.quantity,
                                    },
                                    {
                                      onSuccess: () => {
                                        setEditingKey(null);
                                        setEditCost("");
                                      },
                                    },
                                  );
                                }}
                              >
                                <span className="text-stone-400">$</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={editCost}
                                  onChange={(e) => setEditCost(e.target.value)}
                                  autoFocus
                                  className="w-24 rounded border border-stone-300 px-1.5 py-0.5 text-right font-mono text-sm"
                                />
                                <button
                                  type="submit"
                                  disabled={upsertOverride.isPending}
                                  className="rounded bg-stone-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                                >
                                  save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingKey(null);
                                    setEditCost("");
                                  }}
                                  className="rounded px-1.5 py-0.5 text-xs text-stone-500 hover:bg-stone-100"
                                >
                                  cancel
                                </button>
                              </form>
                            ) : h.cost_basis != null && !h.closed ? (
                              <div className="flex items-center justify-end gap-2">
                                <div>
                                  {fmt.amount(h.cost_basis)}
                                  {sourceBadge && (
                                    <div className={`text-xs ${sourceBadge.cls}`}>
                                      {sourceBadge.label}
                                    </div>
                                  )}
                                </div>
                                {canEdit && (
                                  <div className="flex flex-col gap-0.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingKey(rowKey);
                                        setEditCost(
                                          (h.cost_basis ?? 0).toFixed(2),
                                        );
                                      }}
                                      className="rounded px-1.5 py-0.5 text-xs text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                                      title="Set manual cost basis"
                                    >
                                      edit
                                    </button>
                                    {overrideId != null && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              `Remove manual basis override for ${h.symbol}? Basis will become blank for this holding.`,
                                            )
                                          ) {
                                            deleteOverride.mutate(overrideId);
                                          }
                                        }}
                                        className="rounded px-1.5 py-0.5 text-xs text-rose-400 hover:bg-rose-50 hover:text-rose-700"
                                        title="Delete override"
                                      >
                                        clear
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : canEdit ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingKey(rowKey);
                                  setEditCost("");
                                }}
                                className="rounded px-2 py-0.5 text-xs text-sky-600 hover:bg-sky-50"
                              >
                                + set basis
                              </button>
                            ) : (
                              <span className="text-stone-300">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-right">
                            {h.unrealized_pnl != null && !h.closed ? (
                              <div>
                                <span
                                  className={`font-mono tabular-nums ${
                                    h.unrealized_pnl >= 0
                                      ? "text-emerald-700"
                                      : "text-rose-700"
                                  }`}
                                >
                                  {h.unrealized_pnl >= 0 ? "+" : ""}
                                  {formatUsd(h.unrealized_pnl)}
                                </span>
                                {pnlPct != null && (
                                  <div
                                    className={`text-xs ${
                                      pnlPct >= 0
                                        ? "text-emerald-500"
                                        : "text-rose-500"
                                    }`}
                                  >
                                    {pnlPct >= 0 ? "+" : ""}
                                    {formatPct(pnlPct)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-stone-300">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-right">
                            {h.realized_pnl != null ? (
                              <span
                                className={`font-mono tabular-nums ${
                                  h.realized_pnl >= 0
                                    ? "text-emerald-700"
                                    : "text-rose-700"
                                }`}
                              >
                                {h.realized_pnl >= 0 ? "+" : ""}
                                {formatUsd(h.realized_pnl)}
                              </span>
                            ) : (
                              <span className="text-stone-300">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 pr-6 text-right">
                            {hasReturnData ? (
                              <span
                                className={`font-mono font-semibold tabular-nums ${
                                  totalReturn >= 0
                                    ? "text-emerald-700"
                                    : "text-rose-700"
                                }`}
                              >
                                {totalReturn >= 0 ? "+" : ""}
                                {formatUsd(totalReturn)}
                              </span>
                            ) : (
                              <span className="text-stone-300">—</span>
                            )}
                          </td>
                        </tr>
                        {isExpanded && hasTrades && (
                          <tr>
                            <td colSpan={8} className="bg-stone-50/60 px-6 py-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
                                {symbolTrades.length} trade
                                {symbolTrades.length === 1 ? "" : "s"} on{" "}
                                {h.symbol}
                              </div>
                              <div className="max-h-72 overflow-y-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left uppercase tracking-wider text-stone-400">
                                      <th className="py-1 pr-3 font-medium">
                                        Date
                                      </th>
                                      <th className="py-1 pr-3 font-medium">
                                        Type
                                      </th>
                                      <th className="py-1 pr-3 font-medium">
                                        Sent
                                      </th>
                                      <th className="py-1 pr-3 font-medium">
                                        Received
                                      </th>
                                      <th className="py-1 text-right font-medium">
                                        P&L
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-stone-100">
                                    {symbolTrades
                                      .slice()
                                      .sort((a, b) =>
                                        a.date < b.date ? 1 : -1,
                                      )
                                      .map((t, i) => {
                                        const typeColor =
                                          t.type === "BUY"
                                            ? "bg-emerald-50 text-emerald-700"
                                            : t.type === "SELL"
                                              ? "bg-rose-50 text-rose-700"
                                              : t.type === "TRADE"
                                                ? "bg-violet-50 text-violet-700"
                                                : t.type === "LOSS"
                                                  ? "bg-red-50 text-red-700"
                                                  : "bg-stone-100 text-stone-600";
                                        const fmtTQty = (n: number) =>
                                          n < 0.01
                                            ? n.toFixed(6)
                                            : n < 1
                                              ? n.toFixed(4)
                                              : n < 100
                                                ? n.toFixed(2)
                                                : n.toLocaleString("en-US", {
                                                    maximumFractionDigits: 2,
                                                  });
                                        return (
                                          <tr
                                            key={`${t.date}-${t.type}-${i}`}
                                            className="hover:bg-white"
                                          >
                                            <td className="whitespace-nowrap py-1 pr-3 text-stone-500">
                                              {formatDate(t.date)}
                                            </td>
                                            <td className="py-1 pr-3">
                                              <span
                                                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${typeColor}`}
                                              >
                                                {t.type}
                                              </span>
                                            </td>
                                            <td className="py-1 pr-3 text-stone-700">
                                              {t.sent_currency &&
                                              t.sent_qty > 0 ? (
                                                <>
                                                  {fmtTQty(t.sent_qty)}{" "}
                                                  <span className="font-medium">
                                                    {t.sent_currency}
                                                  </span>
                                                </>
                                              ) : (
                                                <span className="text-stone-300">
                                                  —
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-1 pr-3 text-stone-700">
                                              {t.recv_currency &&
                                              t.recv_qty > 0 ? (
                                                <>
                                                  {fmtTQty(t.recv_qty)}{" "}
                                                  <span className="font-medium">
                                                    {t.recv_currency}
                                                  </span>
                                                </>
                                              ) : (
                                                <span className="text-stone-300">
                                                  —
                                                </span>
                                              )}
                                            </td>
                                            <td
                                              className={`whitespace-nowrap py-1 text-right font-mono tabular-nums ${
                                                t.realized_pnl === 0
                                                  ? "text-stone-400"
                                                  : t.realized_pnl > 0
                                                    ? "text-emerald-700"
                                                    : "text-rose-700"
                                              }`}
                                            >
                                              {t.realized_pnl === 0
                                                ? "—"
                                                : `${t.realized_pnl > 0 ? "+" : ""}${formatUsd(t.realized_pnl)}`}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {manualAdjustments !== 0 && (
            <div className="border-t border-stone-100 px-6 py-2 text-xs text-stone-500">
              <span className="font-medium">Note:</span> realized totals include{" "}
              <span
                className={
                  manualAdjustments >= 0 ? "text-emerald-700" : "text-rose-700"
                }
              >
                {formatUsd(manualAdjustments)}
              </span>{" "}
              of manual adjustments (e.g. off-exchange or perps write-downs)
              not tied to a specific symbol.
            </div>
          )}
        </section>
      )}

      {/* Trades table */}
      <section className="mb-6 rounded-lg border border-stone-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
            Trades
            {visibleTrades && (
              <span className="ml-2 text-xs font-normal normal-case text-stone-400">
                {visibleTrades.length} trades
              </span>
            )}
          </h2>
          <div className="flex flex-wrap gap-1">
            {tradeTypes.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setTradesFilter(f)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  tradesFilter === f
                    ? "bg-stone-900 text-white"
                    : "text-stone-600 hover:bg-stone-100"
                }`}
              >
                {f === "ALL" ? "All" : f}
              </button>
            ))}
          </div>
        </div>
        {tradesQ.isLoading ? (
          <p className="px-6 py-8 text-sm text-stone-500">loading…</p>
        ) : !visibleTrades || visibleTrades.length === 0 ? (
          <p className="px-6 py-8 text-sm text-stone-500">
            No trades in this time range.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="sticky top-0 border-b border-stone-100 bg-white text-left text-xs uppercase tracking-wider text-stone-500">
                  <th className="px-6 py-2 font-medium">Date</th>
                  <th className="px-6 py-2 font-medium">Type</th>
                  <th className="px-6 py-2 font-medium">Sent</th>
                  <th className="px-6 py-2 font-medium">Received</th>
                  <th className="px-6 py-2 text-right font-medium">
                    Basis
                  </th>
                  <th className="px-6 py-2 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-50">
                {visibleTrades.map((t, i) => {
                  const typeColor =
                    t.type === "BUY"
                      ? "bg-emerald-50 text-emerald-700"
                      : t.type === "SELL"
                        ? "bg-rose-50 text-rose-700"
                        : t.type === "TRADE"
                          ? "bg-violet-50 text-violet-700"
                          : t.type === "SEND"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-stone-100 text-stone-600";
                  const fmtQty = (n: number) =>
                    n < 0.01
                      ? n.toFixed(8)
                      : n < 1
                        ? n.toFixed(6)
                        : n < 100
                          ? n.toFixed(4)
                          : n.toLocaleString("en-US", {
                              maximumFractionDigits: 2,
                            });
                  return (
                    <tr
                      key={`${t.date}-${t.type}-${i}`}
                      className="hover:bg-stone-50"
                    >
                      <td className="whitespace-nowrap px-6 py-2 text-stone-600">
                        {formatDate(t.date)}
                      </td>
                      <td className="px-6 py-2">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${typeColor}`}
                        >
                          {t.type}
                        </span>
                      </td>
                      <td className="px-6 py-2 text-stone-800">
                        {t.sent_currency && t.sent_qty > 0 ? (
                          <div>
                            <div>
                              {fmtQty(t.sent_qty)}{" "}
                              <span className="font-medium">
                                {t.sent_currency}
                              </span>
                            </div>
                            {t.sent_currency !== "USD" && t.sent_basis > 0 && (
                              <div className="text-xs text-stone-400">
                                {formatUsd(t.sent_basis)}
                              </div>
                            )}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-6 py-2 text-stone-800">
                        {t.recv_currency && t.recv_qty > 0 ? (
                          <div>
                            <div>
                              {fmtQty(t.recv_qty)}{" "}
                              <span className="font-medium">
                                {t.recv_currency}
                              </span>
                            </div>
                            {t.recv_currency !== "USD" && t.recv_basis > 0 && (
                              <div className="text-xs text-stone-400">
                                {formatUsd(t.recv_basis)}
                              </div>
                            )}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="whitespace-nowrap px-6 py-2 text-right font-mono tabular-nums text-stone-600">
                        {t.sent_basis > 0
                          ? formatUsd(t.sent_basis)
                          : t.recv_basis > 0
                            ? formatUsd(t.recv_basis)
                            : "—"}
                      </td>
                      <td
                        className={`whitespace-nowrap px-6 py-2 text-right font-mono tabular-nums ${
                          t.realized_pnl === 0
                            ? "text-stone-400"
                            : t.realized_pnl > 0
                              ? "text-emerald-700"
                              : "text-rose-700"
                        }`}
                      >
                        {t.realized_pnl === 0
                          ? "—"
                          : `${t.realized_pnl > 0 ? "+" : ""}${formatUsd(t.realized_pnl)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cash flows table */}
      <section className="mb-6 rounded-lg border border-stone-200 bg-white shadow-sm">
        <div className="border-b border-stone-200 px-6 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
            Cash flows
          </h2>
        </div>
        {flowsQ.isLoading ? (
          <p className="px-6 py-8 text-sm text-stone-500">loading…</p>
        ) : !filteredFlows || filteredFlows.length === 0 ? (
          <p className="px-6 py-8 text-sm text-stone-500">
            No cash flows in this time range.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wider text-stone-500">
                <th className="px-6 py-2 font-medium">Date</th>
                <th className="px-6 py-2 font-medium">Account</th>
                <th className="px-6 py-2 font-medium">From</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-50">
              {filteredFlows.map((f, i) => (
                <tr
                  key={`${f.date}-${f.account_id}-${i}`}
                  className="hover:bg-stone-50"
                >
                  <td className="whitespace-nowrap px-6 py-2 text-stone-600">
                    {formatDate(f.date)}
                  </td>
                  <td className="px-6 py-2 text-stone-800">
                    {f.account_name}
                  </td>
                  <td className="px-6 py-2 text-stone-500">
                    {f.counterparty_name}
                  </td>
                  <td
                    className={`whitespace-nowrap px-6 py-2 text-right font-mono tabular-nums ${
                      f.direction === "in"
                        ? "text-emerald-700"
                        : "text-rose-700"
                    }`}
                  >
                    {f.direction === "in" ? "+" : ""}
                    {formatUsd(f.amount, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Today's DeFi breakdown — per-chain, per-wallet Zerion positions */}
      {defiQ.data && defiQ.data.chains.length > 0 && (
        <section className="mb-6 rounded-lg border border-stone-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
              DeFi breakdown
              <span className="ml-2 text-xs font-normal normal-case text-stone-400">
                as of {formatDate(defiQ.data.as_of)}
              </span>
            </h2>
            <span className="font-mono text-sm font-semibold text-stone-800">
              {fmt.amount(defiQ.data.total)}
            </span>
          </div>
          <div className="divide-y divide-stone-100">
            {defiQ.data.chains.map((c) => {
              const open = expandedChains.has(c.chain);
              const pct =
                defiQ.data.total > 0
                  ? (c.total / defiQ.data.total) * 100
                  : 0;
              return (
                <div key={c.chain || "other"}>
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedChains((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.chain)) next.delete(c.chain);
                        else next.add(c.chain);
                        return next;
                      })
                    }
                    className="flex w-full items-center justify-between px-6 py-3 text-left hover:bg-stone-50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-stone-400 text-xs">
                        {open ? "▼" : "▶"}
                      </span>
                      <span className="font-medium text-stone-800">
                        {c.label}
                      </span>
                      <span className="text-xs text-stone-400">
                        {c.wallets.length} wallet
                        {c.wallets.length === 1 ? "" : "s"} ·{" "}
                        {c.wallets.reduce(
                          (n, w) => n + w.positions.length,
                          0,
                        )}{" "}
                        pos
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-stone-400">
                        {formatPct(pct)}
                      </span>
                      <span className="font-mono text-sm tabular-nums text-stone-800">
                        {fmt.amount(c.total)}
                      </span>
                    </div>
                  </button>
                  {open && (
                    <div className="bg-stone-50/50 px-6 py-3">
                      {c.wallets.map((w) => (
                        <div
                          key={w.account_id}
                          className="mb-3 last:mb-0"
                        >
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                              {w.label}
                            </span>
                            <span className="font-mono text-xs tabular-nums text-stone-600">
                              {fmt.amount(w.total)}
                            </span>
                          </div>
                          <table className="w-full text-sm">
                            <tbody className="divide-y divide-stone-100">
                              {w.positions.map((p, i) => {
                                return (
                                  <tr
                                    key={`${p.symbol}-${p.contract_address}-${i}`}
                                  >
                                    <td className="py-1 font-medium text-stone-700">
                                      {p.symbol}
                                    </td>
                                    <td className="py-1 text-right font-mono tabular-nums text-stone-500">
                                      {formatQty(p.quantity)}
                                    </td>
                                    <td className="w-24 py-1 text-right font-mono tabular-nums text-stone-700">
                                      {fmt.amount(p.value_usd)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
