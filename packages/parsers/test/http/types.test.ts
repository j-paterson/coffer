import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETRY,
  type FetchJson,
  type FetchJsonOpts,
  type RetryPolicy,
} from "../../src/types/http";

describe("types/http", () => {
  test("DEFAULT_RETRY has the documented values", () => {
    expect(DEFAULT_RETRY.maxAttempts).toBe(4);
    expect(DEFAULT_RETRY.baseDelayMs).toBe(500);
    expect(DEFAULT_RETRY.maxDelayMs).toBe(30000);
    expect(DEFAULT_RETRY.jitterMs).toBe(250);
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(DEFAULT_RETRY.retriableStatuses.has(s)).toBe(true);
    }
    for (const s of [200, 400, 401, 403, 404]) {
      expect(DEFAULT_RETRY.retriableStatuses.has(s)).toBe(false);
    }
  });

  test("FetchJson + FetchJsonOpts are usable type aliases", () => {
    const opts: FetchJsonOpts = { method: "POST", body: { x: 1 }, retries: 0 };
    expect(opts.method).toBe("POST");
    // Compile-only: FetchJson must accept (url, opts?) and return Promise<T>.
    const _check: FetchJson = async <T>(_: string | URL, __?: FetchJsonOpts) =>
      ({} as T);
    void _check;
    const _policy: RetryPolicy = { ...DEFAULT_RETRY };
    void _policy;
  });
});
