import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import smokeRuntime from '../../examples/smoke-site/src/runtime';
import { handleManage, handleStatus } from '../../src/handlers';

function isD1Database(value: unknown): value is D1Database {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'prepare') === 'function';
}

const databaseBinding: unknown = Reflect.get(env, 'BOOKKIT_DB');
if (!isD1Database(databaseBinding)) throw new Error('BOOKKIT_DB test binding is unavailable');
const db = databaseBinding;

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
});

describe('local smoke runtime', () => {
  it('confirms its paid session and regenerates usable management tokens', async () => {
    const tokenKey = 'local-demo-token-encryption-key';
    const request = new Request('http://localhost:4321/api/booking/status');
    const context = await smokeRuntime.createContext({
      request,
      locals: { env: {
        BOOKKIT_DB: db,
        BOOKKIT_TOKEN_ENC_KEY: tokenKey,
        TOURFLOW_SHARED_SECRET: 'local-tourflow-secret',
      } },
    });
    const id = 'smoke-runtime-booking';
    const cancelToken = 'smoke-customer-token';
    const operatorToken = 'smoke-operator-token';
    const hold = await context.repo.insertHold({
      id,
      reference: 'BKT-2026-SMOKE',
      tourSlug: 'oldTown',
      people: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:30:00.000Z',
      locale: 'en',
      priceCents: 12000,
      holdExpiresAt: '2026-08-01T08:30:00.000Z',
      cancelToken,
      operatorToken,
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    const checkout = await context.providers.payments.createCheckout(hold, context.config);
    await context.repo.updateBooking(id, {
      stripeSessionId: checkout.sessionId,
      updatedAt: '2026-07-21T10:01:00.000Z',
    });

    const status = await handleStatus(new Request(
      `http://localhost:4321/api/booking/status?session_id=${encodeURIComponent(checkout.sessionId)}`,
    ), context);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ status: 'confirmed' });

    const confirmed = await context.repo.getBookingById(id);
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      cancelToken,
      operatorToken,
    });
    expect(confirmed?.cancelToken.startsWith('nohash:')).toBe(false);
    expect(confirmed?.operatorToken.startsWith('nohash:')).toBe(false);

    const manage = await handleManage(new Request(
      `http://localhost:4321/api/booking/manage?token=${encodeURIComponent(operatorToken)}`,
    ), context);
    expect(manage.status).toBe(200);
    await expect(manage.json()).resolves.toMatchObject({ role: 'operator' });
  });
});
