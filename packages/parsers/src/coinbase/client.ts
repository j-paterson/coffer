import type { FetchJson } from "../types/http";

export const USER_AGENT = "finance-parsers/coinbase";

/** Builds a Coinbase Cloud ES256 JWT for a given (METHOD, HOST, PATH). */
export type BuildJwt = (args: {
  method: string;
  host: string;
  path: string;
}) => Promise<string>;

export interface V3AvailableBalance {
  value: string;
  currency: string;
}

export interface V3Account {
  uuid: string;
  name: string;
  currency: string;
  available_balance: V3AvailableBalance;
  type?: string;
  // Coinbase returns more fields; carry them through opaquely for raw_event payload.
  [k: string]: unknown;
}

interface V3AccountsPage {
  accounts: V3Account[];
  has_next: boolean;
  cursor?: string;
}

export interface FetchV3AccountsOpts {
  fetchJson: FetchJson;
  baseUrl: string;     // e.g., "https://api.coinbase.com"
  buildJwt: BuildJwt;
  userAgent: string;
}

export async function fetchV3Accounts(opts: FetchV3AccountsOpts): Promise<V3Account[]> {
  const host = new URL(opts.baseUrl).host;
  const path = "/api/v3/brokerage/accounts";
  const out: V3Account[] = [];
  let cursor: string | undefined;

  for (;;) {
    const q = new URLSearchParams({ limit: "250" });
    if (cursor) q.set("cursor", cursor);
    const url = `${opts.baseUrl}${path}?${q.toString()}`;
    const jwt = await opts.buildJwt({ method: "GET", host, path });
    const page = await opts.fetchJson<V3AccountsPage>(url, {
      headers: {
        authorization: `Bearer ${jwt}`,
        "user-agent": opts.userAgent,
        accept: "application/json",
      },
    });
    for (const a of page.accounts ?? []) out.push(a);
    if (!page.has_next) break;
    if (!page.cursor) break; // defensive
    cursor = page.cursor;
  }

  return out;
}

export interface V2Account {
  id: string;
  name: string;
  currency: string | { code: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface V2Page<T> {
  data?: T[];
  pagination?: { next_uri?: string | null };
}

export interface FetchV2AccountsOpts {
  fetchJson: FetchJson;
  baseUrl: string;
  buildJwt: BuildJwt;
  userAgent: string;
}

export async function fetchV2Accounts(opts: FetchV2AccountsOpts): Promise<V2Account[]> {
  return paginateV2<V2Account>({
    fetchJson: opts.fetchJson,
    baseUrl: opts.baseUrl,
    buildJwt: opts.buildJwt,
    userAgent: opts.userAgent,
    initialPath: "/v2/accounts?limit=100",
  });
}

export interface V2TransactionAmount {
  amount: string;     // signed decimal as string
  currency: string;
}

export interface V2Transaction {
  id: string;
  amount: V2TransactionAmount;
  created_at: string; // ISO-8601 UTC
  type: string;       // "send" | "buy" | "sell" | "fiat_deposit" | ...
  [k: string]: unknown;
}

export interface FetchV2TransactionsOpts {
  fetchJson: FetchJson;
  baseUrl: string;
  buildJwt: BuildJwt;
  userAgent: string;
  accountId: string;
}

export async function fetchV2Transactions(opts: FetchV2TransactionsOpts): Promise<V2Transaction[]> {
  return paginateV2<V2Transaction>({
    fetchJson: opts.fetchJson,
    baseUrl: opts.baseUrl,
    buildJwt: opts.buildJwt,
    userAgent: opts.userAgent,
    initialPath: `/v2/accounts/${encodeURIComponent(opts.accountId)}/transactions?limit=100`,
  });
}

interface PaginateV2Opts {
  fetchJson: FetchJson;
  baseUrl: string;
  buildJwt: BuildJwt;
  userAgent: string;
  initialPath: string;
}

async function paginateV2<T>(opts: PaginateV2Opts): Promise<T[]> {
  const host = new URL(opts.baseUrl).host;
  const out: T[] = [];
  let nextPath: string | null = opts.initialPath;

  while (nextPath) {
    const pathOnly = nextPath.split("?")[0]!;
    const jwt = await opts.buildJwt({ method: "GET", host, path: pathOnly });
    const url: string = `${opts.baseUrl}${nextPath}`;
    const page: V2Page<T> = await opts.fetchJson<V2Page<T>>(url, {
      headers: {
        authorization: `Bearer ${jwt}`,
        "user-agent": opts.userAgent,
        accept: "application/json",
      },
    });
    for (const item of page.data ?? []) out.push(item);
    nextPath = page.pagination?.next_uri ?? null;
  }

  return out;
}
