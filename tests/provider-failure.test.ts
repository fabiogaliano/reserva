import { describe, expect, it } from 'vitest';
import { classifyProviderError, ProviderFailure } from '../src/provider-failure';

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

  // 408/425/429 and every 5xx are transient; every other 4xx is a permanent rejection.
  it.each([
    [408, true], [425, true], [429, true], [500, true], [502, true], [503, true], [504, true], [599, true],
    [400, false], [401, false], [403, false], [404, false], [409, false], [410, false], [422, false],
  ])('reads a numeric `.status` %i off a plain error-shaped object as retryable=%s', (status, retryable) => {
    expect(classifyProviderError({ status })).toEqual({ status, retryable });
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
