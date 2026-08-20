import { describe, expect, it } from 'vitest';
import { isRetryableStatus, isRetryableError, backoffDelayMs } from '../src/upstream/retry.js';

describe('isRetryableStatus', () => {
  it('retries transient server and rate-limit failures', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('does not retry client mistakes that will never succeed', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('does not retry successes', () => {
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('retries network-level failures', () => {
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('does not retry our own timeout aborts', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isRetryableError(abort)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with the attempt number', () => {
    const full = () => 1; // full jitter at maximum
    expect(backoffDelayMs(0, { random: full })).toBe(250);
    expect(backoffDelayMs(1, { random: full })).toBe(500);
    expect(backoffDelayMs(2, { random: full })).toBe(1000);
  });

  it('caps the delay so a long outage does not stall requests forever', () => {
    expect(backoffDelayMs(20, { random: () => 1 })).toBe(8000);
  });

  it('applies jitter so simultaneous retries spread out', () => {
    expect(backoffDelayMs(3, { random: () => 0 })).toBe(0);
    expect(backoffDelayMs(3, { random: () => 0.5 })).toBe(1000);
  });
});
