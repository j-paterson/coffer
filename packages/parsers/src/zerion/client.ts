import type { FetchJson } from "../types/http";

export const USER_AGENT = "finance-parsers/zerion";

/**
 * HTTP Basic auth header for Zerion: API key as username, empty password.
 * The trailing ':' matches Python's `f"{key}:"` and Zerion's docs.
 */
export function basicAuthHeader(apiKey: string): string {
  return "Basic " + btoa(apiKey + ":");
}

/** Narrow response shapes — only the fields the mapper actually reads. */
export interface ZerionPositionRow {
  id?: string;
  type?: string;
  attributes?: {
    quantity?: { float?: number; numeric?: string; decimals?: number };
    value?: number;
    fungible_info?: {
      symbol?: string;
      implementations?: Array<{
        chain_id?: string;
        address?: string | null;
        decimals?: number;
      }>;
    };
  };
  relationships?: {
    chain?:    { data?: { id?: string } };
    fungible?: { data?: { id?: string } };
  };
}

export interface ZerionPositionsResponse {
  data: ZerionPositionRow[];
}

interface RawPositionsPage {
  data?: ZerionPositionRow[];
  links?: { next?: string | null };
}

/**
 * Fetches all positions for an EVM wallet, following JSON:API
 * pagination (`links.next`) until exhausted.
 */
export async function fetchPositions(opts: {
  fetchJson: FetchJson;
  baseUrl: string;
  basicAuthHeader: string;
  address: string;
  userAgent: string;
}): Promise<ZerionPositionsResponse> {
  const headers = {
    authorization: opts.basicAuthHeader,
    "user-agent":  opts.userAgent,
    accept:        "application/json",
  };
  const addr = opts.address.toLowerCase();
  const initialUrl =
    `${opts.baseUrl}/wallets/${addr}/positions/` +
    `?currency=usd&filter%5Btrash%5D=only_non_trash&page%5Bsize%5D=100`;

  const all: ZerionPositionRow[] = [];
  let url: string | null = initialUrl;
  while (url) {
    const page: RawPositionsPage = await opts.fetchJson(url, { headers });
    if (Array.isArray(page.data)) all.push(...page.data);
    url = page.links?.next ?? null;
  }
  return { data: all };
}

export interface ZerionChartResponse {
  data: {
    type?: string;
    attributes: {
      points: Array<[number, number]>;
    };
  };
}

export async function fetchWalletChart(opts: {
  fetchJson: FetchJson;
  baseUrl: string;
  basicAuthHeader: string;
  address: string;
  chain: string;
  userAgent: string;
}): Promise<ZerionChartResponse> {
  const headers = {
    authorization: opts.basicAuthHeader,
    "user-agent":  opts.userAgent,
    accept:        "application/json",
  };
  const addr = opts.address.toLowerCase();
  const url =
    `${opts.baseUrl}/wallets/${addr}/charts/year` +
    `?currency=usd&filter%5Bchain_ids%5D=${encodeURIComponent(opts.chain)}`;
  return opts.fetchJson<ZerionChartResponse>(url, { headers });
}

export interface ZerionFungibleChartResponse {
  data: {
    attributes: {
      symbol: string;
      implementations: Array<{
        chain_id: string;
        address: string | null;
        decimals?: number;
      }>;
      points: Array<[number, number]>;
    };
  };
}

export async function fetchFungibleChart(opts: {
  fetchJson: FetchJson;
  baseUrl: string;
  basicAuthHeader: string;
  fungibleId: string;
  userAgent: string;
}): Promise<ZerionFungibleChartResponse> {
  const headers = {
    authorization: opts.basicAuthHeader,
    "user-agent":  opts.userAgent,
    accept:        "application/json",
  };
  const url =
    `${opts.baseUrl}/fungibles/${encodeURIComponent(opts.fungibleId)}/charts/year` +
    `?currency=usd`;
  return opts.fetchJson<ZerionFungibleChartResponse>(url, { headers });
}
