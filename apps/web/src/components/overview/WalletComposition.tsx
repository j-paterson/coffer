/** Wallet composition panel.
 *
 * Shown below the wallet history chart when a multi-chain Zerion wallet
 * is selected. Renders, per chain:
 *   - Zerion total (authoritative wallet value from their chart API)
 *   - Alchemy direct-token sum (sum of our on-chain position snapshots)
 *   - Residual = Zerion total − Alchemy sum
 *       > 0  → DeFi / LP positions Alchemy can't enumerate; shown as
 *              an "Unidentified" row.
 *       < 0  → Alchemy sees more than Zerion; flagged because Zerion
 *              may have spam-filtered a real holding. Row shows a
 *              warning instead of the residual line.
 *   - Top tokens from Alchemy (symbol + value).
 *
 * Rendered from data returned by GET /api/accounts/wallets/:addr/composition.
 */

import { useWalletComposition } from "../../lib/queries";
import { usePrivateFormat } from "../../lib/privacy";

export function WalletComposition({ address }: { address: string }) {
  const fmt = usePrivateFormat();
  const q = useWalletComposition(address);

  if (q.isLoading) {
    return (
      <div className="mt-4 rounded border border-stone-100 p-3 text-xs text-stone-400">
        loading composition…
      </div>
    );
  }
  if (q.error || !q.data) {
    return null;
  }
  const { per_chain, totals } = q.data;
  const nonEmpty = per_chain.filter(
    (r) => r.zerion_total > 1 || r.alchemy_sum > 1,
  );
  if (nonEmpty.length === 0) return null;

  return (
    <div className="mt-4 rounded border border-stone-200 bg-white">
      <div className="border-b border-stone-100 px-3 py-2">
        <div className="flex items-center justify-between text-xs">
          <div className="font-semibold uppercase tracking-wider text-stone-500">
            Composition
          </div>
          <div className="flex gap-4 font-mono tabular-nums text-stone-600">
            <span>Zerion {fmt.amount(totals.zerion_total)}</span>
            <span>Alchemy {fmt.amount(totals.alchemy_sum)}</span>
            <span>
              Residual{" "}
              <span
                className={
                  totals.residual < -50
                    ? "text-amber-700"
                    : "text-stone-700"
                }
              >
                {fmt.amount(totals.residual)}
              </span>
            </span>
          </div>
        </div>
      </div>
      <div className="divide-y divide-stone-100">
        {nonEmpty.map((row) => (
          <ChainPanel key={row.account_id} row={row} />
        ))}
      </div>
    </div>
  );
}

function ChainPanel({
  row,
}: {
  row: {
    chain: string;
    zerion_total: number;
    zerion_anchor_date: string | null;
    alchemy_sum: number;
    residual: number;
    flag: "alchemy_exceeds_zerion" | null;
    positions: {
      symbol: string;
      chain: string;
      contract_address: string;
      quantity: number;
      value_usd: number;
      as_of: string;
    }[];
  };
}) {
  const fmt = usePrivateFormat();
  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium capitalize text-stone-800">
          {row.chain}
        </div>
        <div className="flex gap-3 font-mono text-xs tabular-nums text-stone-500">
          <span>Z {fmt.amount(row.zerion_total)}</span>
          <span>A {fmt.amount(row.alchemy_sum)}</span>
        </div>
      </div>
      {row.flag === "alchemy_exceeds_zerion" ? (
        <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          ⚠ Alchemy detected more value than Zerion reports — Zerion may have
          filtered tokens as spam.
        </div>
      ) : null}
      {(row.positions.length > 0 || row.residual > 50) && (
        <div className="mt-2 space-y-0.5 text-xs">
          {row.positions
            .filter((p) => p.value_usd > 1)
            .map((p, i) => (
              <div
                key={`${p.contract_address}-${i}`}
                className="flex items-center justify-between"
              >
                <span className="truncate text-stone-600">
                  {p.symbol}
                  <span className="ml-1 text-stone-400">
                    {fmt.amount(p.quantity, { cents: false })}
                  </span>
                </span>
                <span className="font-mono tabular-nums text-stone-700">
                  {fmt.amount(p.value_usd)}
                </span>
              </div>
            ))}
          {row.residual > 50 && row.flag !== "alchemy_exceeds_zerion" && (
            <div className="flex items-center justify-between text-stone-500">
              <span className="italic">Unidentified (likely DeFi / LP)</span>
              <span className="font-mono tabular-nums">
                {fmt.amount(row.residual)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
