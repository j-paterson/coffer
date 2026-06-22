import type { Operation } from "@coffer/ledger/runner";
import type { GeckoTerminalPoolListResponse, OhlcvPoint } from "./client";
import type { GeckoTerminalTarget } from "./config";

export interface PoolPick {
  pool_address: string;
  reserve_in_usd: number;
}

export function pickHighestLiquidityPool(
  response: GeckoTerminalPoolListResponse,
  network: string,
): PoolPick | null {
  const prefix = `${network}_`;
  let best: PoolPick | null = null;
  for (const entry of response.data) {
    const raw = entry.attributes?.reserve_in_usd;
    const reserve = typeof raw === "number" ? raw : Number(raw ?? NaN);
    if (!Number.isFinite(reserve)) continue;
    const id = entry.id ?? "";
    const pool_address = id.startsWith(prefix) ? id.slice(prefix.length) : id;
    if (best === null || reserve > best.reserve_in_usd) {
      best = { pool_address, reserve_in_usd: reserve };
    }
  }
  return best;
}

function tsToIsoDate(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

export function* ohlcvToPriceOps(
  points: OhlcvPoint[],
  target: GeckoTerminalTarget,
  fromTs: number,
): Generator<Operation> {
  const seen = new Set<string>();
  const contract = target.contract.toLowerCase();
  for (const point of points) {
    const ts = point[0];
    const close = point[4];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (typeof close !== "number" || !Number.isFinite(close)) continue;
    if (ts < fromTs) continue;
    if (close <= 0) continue;
    const as_of = tsToIsoDate(ts);
    if (seen.has(as_of)) continue;
    seen.add(as_of);
    yield {
      kind: "asset_price",
      draft: {
        chain: target.chain,
        contract_address: contract,
        symbol: target.symbol,
        as_of,
        source: "geckoterminal",
        price_usd: close,
      },
    };
  }
}
