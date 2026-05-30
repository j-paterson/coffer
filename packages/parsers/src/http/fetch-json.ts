import type { Logger } from "../types/logger";
import type { FetchJson, FetchJsonOpts, HttpClient, RetryPolicy } from "../types/http";
import { HttpNetworkError, HttpStatusError } from "./errors";
import { computeBackoff, parseRetryAfter } from "./retry";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function makeFetchJson(
  http: HttpClient,
  logger: Logger,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  random: () => number = Math.random,
): FetchJson {
  return async <T>(url: string | URL, opts: FetchJsonOpts = {}): Promise<T> => {
    const method = opts.method ?? "GET";
    const headers = new Headers(opts.headers ?? {});
    let body: Bun.BodyInit | undefined;
    if (opts.body !== undefined) {
      if (typeof opts.body === "string" || opts.body instanceof Uint8Array) {
        body = opts.body as Bun.BodyInit;
      } else {
        body = JSON.stringify(opts.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }
    const timeoutMs = opts.timeoutMs ?? 30000;
    const maxRetries = opts.retries ?? policy.maxAttempts - 1;
    const acceptStatus = opts.acceptStatus ?? null;
    const urlStr = typeof url === "string" ? url : url.toString();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal;

      let res: Response;
      try {
        res = await http(url, { method, headers, body, signal });
      } catch (err) {
        const attempts = attempt + 1;
        if (attempt === maxRetries) {
          logger.error("http: failed", { url: urlStr, attempts, error: String(err) });
          throw new HttpNetworkError(
            `${method} ${urlStr} failed: ${String(err)}`,
            { url: urlStr, method, attempts, cause: err },
          );
        }
        const waitMs = computeBackoff(attempt, policy, random);
        logger.warn("http: retry", { url: urlStr, attempt: attempts, error: String(err), waitMs });
        await sleep(waitMs);
        continue;
      }

      const accepted = acceptStatus
        ? acceptStatus.includes(res.status)
        : res.status >= 200 && res.status < 300;
      if (accepted) {
        return (await res.json()) as T;
      }

      const retriable = policy.retriableStatuses.has(res.status);
      const attempts = attempt + 1;
      if (!retriable || attempt === maxRetries) {
        const bodyText = await res.text().catch(() => "");
        logger.error("http: failed", { url: urlStr, attempts, status: res.status });
        throw new HttpStatusError(
          `${method} ${urlStr} → ${res.status}`,
          {
            url: urlStr,
            method,
            attempts,
            status: res.status,
            bodyExcerpt: bodyText.slice(0, 512),
          },
        );
      }

      const retryAfter = parseRetryAfter(
        res.headers.get("retry-after"),
        Date.now(),
        policy.maxDelayMs,
      );
      const waitMs = retryAfter ?? computeBackoff(attempt, policy, random);
      logger.warn("http: retry", { url: urlStr, attempt: attempts, status: res.status, waitMs });
      await sleep(waitMs);
    }

    // Unreachable: loop either returns, throws, or continues until maxRetries.
    throw new Error("fetchJson: invariant violated — retry loop exited without return/throw");
  };
}
