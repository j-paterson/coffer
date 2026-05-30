import { describe, expect, test } from "bun:test";
import {
  computeBackoff,
  isRetriableStatus,
  parseRetryAfter,
} from "../../src/http/retry";
import { DEFAULT_RETRY } from "../../src/types/http";

describe("isRetriableStatus", () => {
  test("retries 408, 429, 500-504", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(isRetriableStatus(s, DEFAULT_RETRY)).toBe(true);
    }
  });
  test("does not retry other 4xx or 2xx/3xx", () => {
    for (const s of [200, 301, 400, 401, 403, 404, 422]) {
      expect(isRetriableStatus(s, DEFAULT_RETRY)).toBe(false);
    }
  });
});

describe("computeBackoff", () => {
  test("first attempt is ~baseDelayMs plus jitter", () => {
    const ms = computeBackoff(0, DEFAULT_RETRY, () => 0); // jitter = 0
    expect(ms).toBe(500);
    const ms2 = computeBackoff(0, DEFAULT_RETRY, () => 0.999);
    expect(ms2).toBeGreaterThanOrEqual(500);
    expect(ms2).toBeLessThanOrEqual(750);
  });
  test("exponential growth: attempt 2 ≈ 4x base", () => {
    expect(computeBackoff(2, DEFAULT_RETRY, () => 0)).toBe(2000);
  });
  test("saturates at maxDelayMs", () => {
    const huge = computeBackoff(20, DEFAULT_RETRY, () => 0);
    expect(huge).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
    expect(huge).toBeGreaterThanOrEqual(DEFAULT_RETRY.maxDelayMs - DEFAULT_RETRY.jitterMs);
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-05-11T10:00:00Z");
  const MAX = 30000;

  test("returns null for missing header", () => {
    expect(parseRetryAfter(null, NOW, MAX)).toBeNull();
  });
  test("parses delay-seconds form", () => {
    expect(parseRetryAfter("5", NOW, MAX)).toBe(5000);
  });
  test("parses HTTP-date in the future as ms-until", () => {
    const future = new Date(NOW + 2000).toUTCString();
    const ms = parseRetryAfter(future, NOW, MAX);
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(2000);
  });
  test("HTTP-date in the past clamps to 0", () => {
    const past = new Date(NOW - 10000).toUTCString();
    expect(parseRetryAfter(past, NOW, MAX)).toBe(0);
  });
  test("clamps absurd values to maxDelayMs", () => {
    expect(parseRetryAfter("999999", NOW, MAX)).toBe(MAX);
  });
  test("returns null for garbage", () => {
    expect(parseRetryAfter("not-a-number", NOW, MAX)).toBeNull();
  });
});
