import type { FetchJson } from "../types/http";

/**
 * Sent on every DefiLlama request. Tests assert this value to lock in
 * the convention.
 */
export const USER_AGENT = "finance-parsers/defillama";

interface DefiLlamaPriceRow {
  timestamp: number;
  price: number;
  confidence?: number;
}

interface DefiLlamaCoinEntry {
  symbol?: string;
  prices?: DefiLlamaPriceRow[];
}

interface DefiLlamaChartResponse {
  coins?: Record<string, DefiLlamaCoinEntry>;
}

export type ChartPoint = { ts: number; price: number };

export interface FetchChartChunkOpts {
  fetchJson: FetchJson;
  baseUrl: string;
  coinKey: string;
  startUnix: number;
  span?: number;  // default 500 — DefiLlama's max points-per-call
}

export async function fetchChartChunk(
  opts: FetchChartChunkOpts,
): Promise<{ points: ChartPoint[] }> {
  const span = opts.span ?? 500;
  const url = `${opts.baseUrl}/chart/${encodeURIComponent(opts.coinKey)}`
            + `?start=${opts.startUnix}&span=${span}&period=1d`;
  const resp = await opts.fetchJson<DefiLlamaChartResponse>(url, {
    headers: { "user-agent": USER_AGENT },
  });
  // Response key may differ from request key — DefiLlama normalizes
  // (e.g. lowercases hex addresses). We requested one coin per call,
  // so pulling the first entry by value is safe and avoids re-derivation.
  const first = Object.values(resp.coins ?? {})[0];
  const raw = first?.prices ?? [];
  // Defensive: drop malformed rows.
  const points = raw
    .filter(p => typeof p?.timestamp === "number" && Number.isFinite(p.price))
    .map(p => ({ ts: p.timestamp, price: p.price }));
  return { points };
}
