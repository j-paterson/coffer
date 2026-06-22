import type { FetchJson } from "../types/http";

export const USER_AGENT = "finance-parsers/geckoterminal";

const BASE_URL = "https://api.geckoterminal.com/api/v2";

const HEADERS = { accept: "application/json", "user-agent": USER_AGENT };

export interface GeckoTerminalPoolListEntry {
  id: string;        // "{network}_{address}"
  type: string;      // "pool"
  attributes: {
    reserve_in_usd?: string | number | null;
    [k: string]: unknown;
  };
}

export interface GeckoTerminalPoolListResponse {
  data: GeckoTerminalPoolListEntry[];
}

export interface FetchPoolListOpts {
  fetchJson: FetchJson;
  network: string;
  contract: string;
}

export async function fetchPoolList(
  opts: FetchPoolListOpts,
): Promise<GeckoTerminalPoolListResponse> {
  const contract = opts.contract.toLowerCase();
  const url =
    `${BASE_URL}/networks/${opts.network}/tokens/${contract}/pools?page=1`;
  return opts.fetchJson<GeckoTerminalPoolListResponse>(url, { headers: HEADERS });
}

export type OhlcvPoint = [number, number, number, number, number, number];

export interface GeckoTerminalOhlcvResponse {
  data: {
    attributes: {
      ohlcv_list: OhlcvPoint[];
    };
  };
}

export interface FetchOhlcvOpts {
  fetchJson: FetchJson;
  network: string;
  pool: string;
  beforeTimestamp?: number;
}

export async function fetchOhlcv(
  opts: FetchOhlcvOpts,
): Promise<GeckoTerminalOhlcvResponse> {
  const params = new URLSearchParams({ aggregate: "1", limit: "1000" });
  if (opts.beforeTimestamp !== undefined) {
    params.set("before_timestamp", String(opts.beforeTimestamp));
  }
  const url =
    `${BASE_URL}/networks/${opts.network}/pools/${opts.pool}/ohlcv/day?${params.toString()}`;
  return opts.fetchJson<GeckoTerminalOhlcvResponse>(url, { headers: HEADERS });
}
