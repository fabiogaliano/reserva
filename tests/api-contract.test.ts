// The wire contract's own guards. These assert the three properties the closed error catalog has
// to keep for a consumer (or an agent) to switch exhaustively on failures: it exists as a runtime
// value, it has no duplicate members, and nothing outside it can reach the error envelope.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { API_ERROR_CODES, isApiErrorCode } from '../src/core';
import type {
  ApiErrorCode,
  ApiErrorEnvelope,
  AvailabilityResponse,
  CheckoutResponse,
  ManageActionResponse,
  QuoteResponse,
  StatusResponse,
} from '../src/core';
import { errorResponse, HttpError } from '../src/http';

describe('API_ERROR_CODES (plan 027 design decision 2)', () => {
  it('is a runtime array on the public core entrypoint, so docs and consumers can enumerate it', () => {
    // Imported from '../src/core' (what package.json maps to `@reservajs/astro/core`), not from
    // the internal module — the generated error-code table is built from exactly this import.
    expect(Array.isArray(API_ERROR_CODES)).toBe(true);
    expect(API_ERROR_CODES.length).toBeGreaterThan(0);
    expect(API_ERROR_CODES.every((code) => typeof code === 'string' && code.length > 0)).toBe(true);
  });

  it('has no duplicate members', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it('derives its type from the array, so an unlisted code does not compile', () => {
    expectTypeOf<ApiErrorCode>().toEqualTypeOf<(typeof API_ERROR_CODES)[number]>();
    // @ts-expect-error 'not_a_real_code' is not a member of API_ERROR_CODES.
    const rejected = new HttpError(400, 'not_a_real_code', 'unreachable');
    // The @ts-expect-error above is the assertion; this only keeps the value used.
    expect(rejected).toBeInstanceOf(HttpError);
  });

  it('is the only vocabulary the error envelope can carry', () => {
    expectTypeOf<ApiErrorEnvelope['error']['code']>().toEqualTypeOf<ApiErrorCode>();
    expect(isApiErrorCode('validation_failed')).toBe(true);
    expect(isApiErrorCode('duplicate_payment_ref')).toBe(true);
    expect(isApiErrorCode('nope')).toBe(false);
  });
});

describe('the error envelope (src/http.ts errorResponse)', () => {
  it('serializes an HttpError as { error: { code, message } } at its own status', async () => {
    const response = errorResponse(new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available'));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'slot_unavailable', message: 'The selected slot is no longer available' },
    });
  });

  it('honors a foreign error that already carries a catalog code and an HTTP status', async () => {
    const foreign = Object.assign(new Error('payment_ref pi_1 already confirmed a different booking'), {
      status: 409,
      code: 'duplicate_payment_ref',
    });
    const response = errorResponse(foreign);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'duplicate_payment_ref' } });
  });

  it('downgrades a foreign error whose code is outside the catalog to internal_error', async () => {
    // Without this, any thrown object with a `code` string could put an unenumerable value on the
    // wire — the exact failure the closed set exists to prevent.
    const foreign = Object.assign(new Error('leaky'), { status: 400, code: 'some_provider_specific_code' });
    const response = errorResponse(foreign);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'internal_error', message: 'An unexpected error occurred' },
    });
  });
});

describe('exported wire types (plan 027 design decision 2)', () => {
  it('pins the response envelopes the handlers return', () => {
    expectTypeOf<QuoteResponse>().toEqualTypeOf<{ priceMinor: number; currency: string }>();
    expectTypeOf<CheckoutResponse>().toEqualTypeOf<{ checkoutUrl: string; bookingId: string; reference: string }>();
    expectTypeOf<ManageActionResponse>().toEqualTypeOf<{ ok: true }>();
    // The empty-value rule: a status with no booking detail carries `null`, never a missing key.
    expectTypeOf<StatusResponse['booking']>().toBeNullable();
    // Scarcity is a number or null (above the threshold), never a rendered string.
    expectTypeOf<AvailabilityResponse['days'][number]['slots'][number]['remaining']>().toEqualTypeOf<number | null>();
  });
});
