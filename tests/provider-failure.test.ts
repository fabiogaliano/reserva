import { describe, expect, it } from 'vitest';
import { classifyProviderError, isRetryableStatus, ProviderFailure } from '../src/provider-failure';

describe('isRetryableStatus', () => {
  it('treats 408/425/429 and every 5xx as retryable', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('treats every other 4xx as permanent', () => {
    for (const status of [400, 401, 403, 404, 409, 410, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('defaults retryable when there is no status at all', () => {
    expect(isRetryableStatus(undefined)).toBe(true);
  });
});

describe('ProviderFailure', () => {
  it('derives retryable from status by default', () => {
    expect(new ProviderFailure({ status: 401, message: 'nope' }).retryable).toBe(false);
    expect(new ProviderFailure({ status: 503, message: 'nope' }).retryable).toBe(true);
    expect(new ProviderFailure({ message: 'nope' }).retryable).toBe(true);
  });

  it('lets a caller override the derived retryable value', () => {
    expect(new ProviderFailure({ status: 429, retryable: false, message: 'explicit override' }).retryable).toBe(false);
  });

  it('bounds an unbounded message', () => {
    const failure = new ProviderFailure({ status: 500, message: 'x'.repeat(5_000) });
    expect(failure.message.length).toBeLessThanOrEqual(500);
  });
});

describe('classifyProviderError', () => {
  it('reads status/retryable off a ProviderFailure directly', () => {
    expect(classifyProviderError(new ProviderFailure({ status: 401, message: 'denied' })))
      .toEqual({ status: 401, retryable: false });
  });

  it('reads a numeric `.status` off any plain error-shaped object', () => {
    expect(classifyProviderError({ status: 503 })).toEqual({ status: 503, retryable: true });
    expect(classifyProviderError({ status: 404 })).toEqual({ status: 404, retryable: false });
  });

  it('defaults retryable for a non-HTTP error (no `.status` at all)', () => {
    expect(classifyProviderError(new TypeError('fetch failed'))).toEqual({ status: undefined, retryable: true });
    expect(classifyProviderError('a string throw')).toEqual({ status: undefined, retryable: true });
    expect(classifyProviderError(null)).toEqual({ status: undefined, retryable: true });
  });

  it('ignores a non-numeric `.status`', () => {
    expect(classifyProviderError({ status: 'oops' })).toEqual({ status: undefined, retryable: true });
  });
});
