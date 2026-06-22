import type { RetryPolicy } from "../types/http";

export function isRetriableStatus(status: number, policy: RetryPolicy): boolean {
  return policy.retriableStatuses.has(status);
}

/** 0-indexed attempt count: 0 = wait before the first retry. */
export function computeBackoff(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exp = policy.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.floor(random() * policy.jitterMs);
  return Math.min(exp + jitter, policy.maxDelayMs);
}

/**
 * Parse RFC 7231 `Retry-After`. Returns ms-to-wait, or null if absent/garbage.
 * Past HTTP-dates collapse to 0. Values exceeding maxDelayMs clamp down.
 */
export function parseRetryAfter(
  header: string | null,
  nowMs: number,
  maxDelayMs: number,
): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  // Delay-seconds form.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Math.min(seconds * 1000, maxDelayMs);
  }

  // HTTP-date form.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const delta = parsed - nowMs;
  if (delta <= 0) return 0;
  return Math.min(delta, maxDelayMs);
}
