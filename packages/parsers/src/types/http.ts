export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  retriableStatuses: ReadonlySet<number>;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  jitterMs: 250,
  retriableStatuses: new Set([408, 429, 500, 502, 503, 504]),
};

/** Minimal callable interface satisfied by `fetch`, mocks, and test fakes. */
export type HttpClient = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchJsonOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  acceptStatus?: number[];
  signal?: AbortSignal;
}

export type FetchJson = <T>(
  url: string | URL,
  opts?: FetchJsonOpts,
) => Promise<T>;
