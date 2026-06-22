import type { FetchJson } from "../types/http";

/**
 * Module-level constant; sent on every SimpleFIN request.
 * Tests assert this value to lock in the convention.
 */
export const USER_AGENT = "finance-parsers/simplefin";

export interface SimpleFinTransaction {
  id: string;
  posted?: number;
  transacted_at?: number;
  amount: string;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
}

export interface SimpleFinHolding {
  symbol?: string;
  shares?: string;
  market_value?: string;
  cost_basis?: string;
  description?: string;
  currency?: string;
}

export interface SimpleFinAccount {
  id: string;
  name: string;
  currency?: string;
  balance: string;
  org?: { name?: string; domain?: string };
  transactions?: SimpleFinTransaction[];
  holdings?: SimpleFinHolding[];
}

export interface SimpleFinAccountsResponse {
  accounts: SimpleFinAccount[];
  errlist?: string[];
}

export interface SplitAccessUrl {
  baseUrl: string;          // e.g. https://host.example/simplefin (no auth, no trailing slash)
  basicAuthHeader: string;  // "Basic <b64(user:pass)>"
}

export function splitAccessUrl(accessUrl: string): SplitAccessUrl {
  const u = new URL(accessUrl);
  if (!u.username) {
    throw new Error("SimpleFIN access URL is missing basic-auth credentials");
  }
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const basicAuthHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

  u.username = "";
  u.password = "";
  // URL.toString() preserves a trailing slash if the original had one;
  // strip any number for stable URL composition downstream (Task 3
  // appends /accounts directly).
  const baseUrl = u.toString().replace(/\/+$/, "");

  return { baseUrl, basicAuthHeader };
}

export interface FetchAccountsWindowOpts {
  fetchJson: FetchJson;
  baseUrl: string;
  basicAuthHeader: string;
  startUnix: number;       // inclusive
  endUnix: number;         // exclusive
  includePending: boolean;
  userAgent: string;
}

export async function fetchAccountsWindow(
  opts: FetchAccountsWindowOpts,
): Promise<SimpleFinAccountsResponse> {
  const url =
    `${opts.baseUrl}/accounts` +
    `?start-date=${opts.startUnix}` +
    `&end-date=${opts.endUnix}` +
    `&pending=${opts.includePending ? 1 : 0}`;
  return opts.fetchJson<SimpleFinAccountsResponse>(url, {
    method: "GET",
    headers: {
      Authorization: opts.basicAuthHeader,
      "User-Agent": opts.userAgent,
      Accept: "application/json",
    },
  });
}
