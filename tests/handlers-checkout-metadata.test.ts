import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import type { MetadataField } from '../src/core/config';
import { createReservaContext } from '../src/context';
import { handleCheckout } from '../src/handlers';
import { config, service } from './fixtures';
import { fakeRepository, providers } from './fakes';

// Checkout is the whole validation boundary for consumer-declared
// metadata — unknown keys rejected, required enforced, strict type coercion (no "true" -> boolean),
// the whole serialized object capped at 8 KB, and a declared-less service rejects non-empty
// metadata. Every rejection is a remediating 400 (direction doc §8): it names the offending key,
// its declared type, and the violated constraint.

const dietaryField: MetadataField = { key: 'dietary_notes', label: 'Dietary notes', type: 'text', required: true, maxLength: 20 };
const seatField: MetadataField = {
  key: 'seat_pref', label: 'Seat preference', type: 'select',
  options: [{ value: 'window', label: 'Window' }, { value: 'aisle', label: 'Aisle' }],
};
const vegetarianField: MetadataField = { key: 'vegetarian', label: 'Vegetarian', type: 'boolean' };
const partySizeField: MetadataField = { key: 'kids_count', label: 'Number of kids', type: 'number' };
// A large declared maxLength so a per-field check never fires — isolates the whole-object 8 KB cap.
const notesField: MetadataField = { key: 'notes', label: 'Notes', type: 'text', maxLength: 20_000 };

const metadataConfig = {
  ...config,
  services: {
    ...config.services,
    vintage: { ...service, metadataFields: [dietaryField, seatField, vegetarianField, partySizeField, notesField] },
  },
};

function checkoutRequest(body: Record<string, unknown>): Request {
  return new Request('https://example.test/api/booking/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en', ...body }),
  });
}

function contextFor(clientConfig: typeof config) {
  const repo = fakeRepository();
  const context = createReservaContext({
    config: clientConfig,
    db: {} as D1Database,
    repo,
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    providers: providers(),
  });
  return { context, repo };
}

describe('checkout metadata validation (plan 024)', () => {
  it('accepts a valid metadata object and stores it verbatim on the created hold', async () => {
    const { context, repo } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata: { dietary_notes: 'Vegan', seat_pref: 'window', vegetarian: true } }), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)?.metadata).toEqual({ dietary_notes: 'Vegan', seat_pref: 'window', vegetarian: true });
  });

  it('accepts a checkout with no metadata at all when every declared field is optional', async () => {
    const { context } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata: { dietary_notes: 'None' } }), context);
    expect(response.status).toBe(201);
  });

  it('rejects a missing required field, naming the key and declared type', async () => {
    const { context } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata: { seat_pref: 'window' } }), context);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toContain('dietary_notes');
    expect(body.error.message).toContain('required');
    expect(body.error.message).toContain('text');
  });

  it('rejects an unknown metadata key, naming it and the declared key set', async () => {
    const { context } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata: { dietary_notes: 'Vegan', not_a_field: 'x' } }), context);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('not_a_field');
    expect(body.error.message).toContain('dietary_notes');
  });

  it.each([
    ['a number sent as a string', { dietary_notes: 'Vegan', kids_count: '2' }, 'kids_count', 'number'],
    ['a boolean sent as the string "true" (no truthy coercion)', { dietary_notes: 'Vegan', vegetarian: 'true' }, 'vegetarian', 'boolean'],
    ['a select value not among its declared options', { dietary_notes: 'Vegan', seat_pref: 'middle' }, 'seat_pref', 'select'],
    ['text sent as a number', { dietary_notes: 42 }, 'dietary_notes', 'text'],
  ])('rejects wrong-type metadata: %s', async (_label, metadata, expectedKey, expectedType) => {
    const { context } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata }), context);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain(expectedKey);
    expect(body.error.message).toContain(expectedType);
  });

  it('rejects a text value over its declared per-field maxLength', async () => {
    const { context } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata: { dietary_notes: 'x'.repeat(21) } }), context);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('dietary_notes');
    expect(body.error.message).toContain('20 characters');
  });

  it('rejects a metadata object whose serialized size exceeds 8 KB even when every per-field maxLength is satisfied', async () => {
    const { context } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata: { dietary_notes: 'Vegan', notes: 'x'.repeat(9000) } }), context);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('8192 byte limit');
  });

  it('rejects a non-empty metadata object for a service with no declared fields', async () => {
    const { context } = contextFor(config);
    const response = await handleCheckout(checkoutRequest({ metadata: { anything: 'x' } }), context);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('declares no metadata fields');
  });

  it('accepts an empty metadata object for a service with no declared fields (a no-op, not a rejection)', async () => {
    const { context } = contextFor(config);
    const response = await handleCheckout(checkoutRequest({ metadata: {} }), context);
    expect(response.status).toBe(201);
  });

  it('rejects a non-object metadata value', async () => {
    const { context } = contextFor(metadataConfig);
    const response = await handleCheckout(checkoutRequest({ metadata: 'not-an-object' }), context);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('metadata must be an object');
  });
});
