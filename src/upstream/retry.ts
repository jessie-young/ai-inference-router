/**
 * Retry policy for upstream calls.
 *
 * Only transient failures are retried. A 400 or a 404 is a client mistake:
 * retrying it wastes time, multiplies load on the provider, and never
 * succeeds. A 429 or a 5xx may well succeed on a second attempt.
 */

/** Status codes worth retrying. 408 = request timeout, 429 = rate limited. */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Network-level failures (DNS, connection refused, socket hangup) are always
 * transient from the router's perspective and are always worth one more try.
 * An abort caused by our own timeout is not retried here — the caller decides,
 * because retrying a timeout can blow the client's own deadline.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  return true;
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters more than the exponent here: without it, every request that
 * a provider rate-limits at the same moment retries at the same moment,
 * reproducing the spike that caused the limit. `random` is injectable so the
 * schedule is deterministic under test.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? 250;
  const max = options.maxMs ?? 8_000;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** attempt);
  return Math.round(random() * exponential);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
