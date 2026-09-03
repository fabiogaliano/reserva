// Proves reserva's shipped D1 schema defends itself against real D1: its CHECK constraints and
// partial unique index reject invalid rows at the SQL level, independent of any application
// validation, and a payment_ref can't be silently stolen through any of the repository write paths.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository, DuplicatePaymentRefError } from '../../src/repo';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
});

// A minimal, always-valid row so each rejection-matrix test only overrides the field it's
// testing. Raw SQL is deliberate — this proves the SCHEMA itself rejects the row, independent of
// any application-level validation.
const validBooking = {
  id: 'raw-valid', reference: 'BKT-RAW-VALID', service_slug: 'vintage', quantity: 2, pickup_type: 'default',
  starts_at: '2026-08-01T09:00:00.000Z', ends_at: '2026-08-01T10:00:00.000Z', locale: 'en',
  price_minor: 12000, currency: 'eur', status: 'hold', cancel_token: 'raw-valid-cancel', operator_token: 'raw-valid-operator',
  created_at: '2026-07-21T10:00:00.000Z', updated_at: '2026-07-21T10:00:00.000Z',
} as const;

function insertRawBooking(overrides: Record<string, unknown>) {
  const row: Record<string, unknown> = { ...validBooking, ...overrides };
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO bookings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...columns.map((column) => row[column])).run();
}

describe('bookings CHECK constraints and partial unique index', () => {
  it('rejects quantity = 0', async () => {
    await expect(insertRawBooking({
      id: 'quantity-0', reference: 'BKT-PEOPLE-0', cancel_token: 'ct-quantity-0', operator_token: 'ot-quantity-0', quantity: 0,
    })).rejects.toThrow();
  });

  it('rejects quantity = -1', async () => {
    await expect(insertRawBooking({
      id: 'quantity-neg1', reference: 'BKT-PEOPLE-NEG1', cancel_token: 'ct-quantity-neg1', operator_token: 'ot-quantity-neg1', quantity: -1,
    })).rejects.toThrow();
  });

  it('rejects price_minor = -1', async () => {
    await expect(insertRawBooking({
      id: 'price-neg1', reference: 'BKT-PRICE-NEG1', cancel_token: 'ct-price-neg1', operator_token: 'ot-price-neg1', price_minor: -1,
    })).rejects.toThrow();
  });

  it('rejects ends_at equal to starts_at', async () => {
    await expect(insertRawBooking({
      id: 'ends-eq', reference: 'BKT-ENDS-EQ', cancel_token: 'ct-ends-eq', operator_token: 'ot-ends-eq',
      ends_at: validBooking.starts_at,
    })).rejects.toThrow();
  });

  it('rejects ends_at before starts_at', async () => {
    await expect(insertRawBooking({
      id: 'ends-before', reference: 'BKT-ENDS-BEFORE', cancel_token: 'ct-ends-before', operator_token: 'ot-ends-before',
      ends_at: '2026-08-01T08:00:00.000Z',
    })).rejects.toThrow();
  });

  it('rejects a duplicate payment_ref across two bookings (idx_bookings_payment_ref)', async () => {
    await insertRawBooking({
      id: 'pi-1', reference: 'BKT-PI-1', cancel_token: 'ct-pi-1', operator_token: 'ot-pi-1', payment_ref: 'pi_duplicate_test',
    });
    await expect(insertRawBooking({
      id: 'pi-2', reference: 'BKT-PI-2', cancel_token: 'ct-pi-2', operator_token: 'ot-pi-2', payment_ref: 'pi_duplicate_test',
    })).rejects.toThrow();
  });

  it('allows multiple bookings with a NULL payment_ref (the unique index is partial)', async () => {
    await insertRawBooking({ id: 'pi-null-1', reference: 'BKT-PI-NULL-1', cancel_token: 'ct-pi-null-1', operator_token: 'ot-pi-null-1' });
    await expect(insertRawBooking({
      id: 'pi-null-2', reference: 'BKT-PI-NULL-2', cancel_token: 'ct-pi-null-2', operator_token: 'ot-pi-null-2',
    })).resolves.toBeDefined();
  });

  it('still accepts a fully valid row (control -- the matrix above is testing the CHECKs, not breaking normal inserts)', async () => {
    await expect(insertRawBooking({
      id: 'control-valid', reference: 'BKT-CONTROL-VALID', cancel_token: 'ct-control-valid', operator_token: 'ot-control-valid',
    })).resolves.toBeDefined();
  });

  // pickup_type's domain is config-declared (pickupOptions), which SQL can't enumerate, so the
  // schema must accept any id a consumer's config defines.
  it('accepts a non-enum pickup_type (the domain lives in config, not in a SQL CHECK)', async () => {
    await expect(insertRawBooking({
      id: 'pickup-non-enum', reference: 'BKT-PICKUP-NON-ENUM', cancel_token: 'ct-pickup-non-enum', operator_token: 'ot-pickup-non-enum',
      pickup_type: 'custom_both',
    })).resolves.toBeDefined();
  });
});

describe('capacity table CHECK constraints', () => {
  it('rejects a negative capacity_defaults.capacity', async () => {
    await expect(
      db.prepare('INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', -1, null).run(),
    ).rejects.toThrow();
  });

  it('rejects a negative day_overrides.capacity', async () => {
    await expect(
      db.prepare('INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', -1, null).run(),
    ).rejects.toThrow();
  });

  it('allows capacity = 0 on both capacity tables (a fully closed day/period is valid)', async () => {
    await expect(
      db.prepare('INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', 0, 'closed').run(),
    ).resolves.toBeDefined();
    await expect(
      db.prepare('INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', 0, 'closed').run(),
    ).resolves.toBeDefined();
  });
});

describe('duplicate payment_ref surfaces a clean conflict through the real write paths, not an unhandled 500', () => {
  async function seedHold(id: string) {
    return repo.insertHold({
      id, reference: `BKT-DUPPI-${id}`, serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: `cancel-${id}`, operatorToken: `operator-${id}`,
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });
  }

  it('confirmWithSideEffectOperations rejects a second booking claiming an already-used payment intent, and leaves it unadvanced', async () => {
    const first = await seedHold('confirm-1');
    const second = await seedHold('confirm-2');
    await repo.acquireConfirmationLease(first.id, 'lease-1', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    await repo.confirmWithSideEffectOperations(first.id, {
      expectedStatusIn: ['hold'], paymentRef: 'pi_shared_confirm', leaseToken: 'lease-1', oversold: false,
      updatedAt: '2026-07-21T10:01:00.000Z',
    });

    await repo.acquireConfirmationLease(second.id, 'lease-2', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    const attempt = repo.confirmWithSideEffectOperations(second.id, {
      expectedStatusIn: ['hold'], paymentRef: 'pi_shared_confirm', leaseToken: 'lease-2', oversold: false,
      updatedAt: '2026-07-21T10:02:00.000Z',
    });
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });

    // The batch rolled back atomically -- the loser's status/outbox rows must not have advanced.
    await expect(repo.getBookingById(second.id)).resolves.toMatchObject({ status: 'hold' });
    await expect(repo.listSideEffectOperations(second.id)).resolves.toEqual([]);
  });

  it('applyConfirmedPaymentDetails rejects backfilling an already-confirmed booking with a payment intent already used by another booking', async () => {
    const first = await seedHold('apply-1');
    const second = await seedHold('apply-2');
    await repo.transitionToConfirmed(first.id, {
      expectedStatusIn: ['hold'], paymentRef: 'pi_shared_apply', updatedAt: '2026-07-21T10:01:00.000Z',
    });
    await repo.transitionToConfirmed(second.id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
    await repo.acquireConfirmationLease(second.id, 'lease-apply', '2026-07-21T10:02:00.000Z', '2026-07-21T10:07:00.000Z');

    const attempt = repo.applyConfirmedPaymentDetails(
      second.id, { paymentRef: 'pi_shared_apply' }, 'lease-apply', '2026-07-21T10:03:00.000Z',
    );
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });
    await expect(repo.getBookingById(second.id)).resolves.toMatchObject({ paymentRef: null });
  });

  it('the generic updateBooking also rejects a duplicate payment intent (defense in depth for any future caller)', async () => {
    const first = await seedHold('update-1');
    const second = await seedHold('update-2');
    await repo.updateBooking(first.id, { paymentRef: 'pi_shared_update', updatedAt: '2026-07-21T10:01:00.000Z' });

    const attempt = repo.updateBooking(second.id, { paymentRef: 'pi_shared_update', updatedAt: '2026-07-21T10:02:00.000Z' });
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });
  });

  // guardDuplicatePaymentIntent used to skip reclassification via a truthiness check, so a
  // collision on '' would have bubbled up as an unhandled 500 instead of a clean 409.
  it('also rejects a duplicate EMPTY-STRING payment intent, not just a truthy one', async () => {
    const first = await seedHold('empty-1');
    const second = await seedHold('empty-2');
    await repo.updateBooking(first.id, { paymentRef: '', updatedAt: '2026-07-21T10:01:00.000Z' });

    const attempt = repo.updateBooking(second.id, { paymentRef: '', updatedAt: '2026-07-21T10:02:00.000Z' });
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });
  });
});
