import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import smokeRuntime from '../../examples/smoke-site/src/runtime';
import { handleAdminGet, handleCheckout, handleManage, handleStatus } from '../../src/handlers';

function isD1Database(value: unknown): value is D1Database {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'prepare') === 'function';
}

const databaseBinding: unknown = Reflect.get(env, 'BOOKKIT_DB');
if (!isD1Database(databaseBinding)) throw new Error('BOOKKIT_DB test binding is unavailable');
const db = databaseBinding;

function requireStringProperty(value: unknown, key: string): string {
  if (typeof value === 'object' && value !== null) {
    const property = Reflect.get(value, key);
    if (typeof property === 'string') return property;
  }
  throw new Error(`Expected ${key} in smoke runtime response`);
}

function isDemoEmail(value: unknown): value is { customerManageUrl: string; operatorManageUrl: string } {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'customerManageUrl') === 'string'
    && typeof Reflect.get(value, 'operatorManageUrl') === 'string';
}

function nextSmokeSlot(): string {
  const slot = new Date();
  slot.setUTCDate(slot.getUTCDate() + 1);
  slot.setUTCHours(9, 0, 0, 0);
  return slot.toISOString();
}

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
});

describe('local smoke runtime', () => {
  it('confirms a checkout through strict verification and renders usable management links', async () => {
    const request = new Request('http://localhost:4321/api/booking/checkout');
    const context = await smokeRuntime.createContext({
      request,
      locals: { env: {
        BOOKKIT_DB: db,
        BOOKKIT_TOKEN_ENC_KEY: 'local-demo-token-encryption-key',
        BOOKKIT_OPERATOR_SECRET: 'local-operator-secret',
      } },
    });
    const emailSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const checkout = await handleCheckout(new Request(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tourSlug: 'oldTown',
          start: nextSmokeSlot(),
          people: 2,
          pickupType: 'default',
          locale: 'en',
          // Plan 017 (design decision 5): the smoke-site's oldTown tour now declares two meeting
          // points (examples/smoke-site/src/config.ts), so a default-pickup checkout must supply
          // one — see resolveCheckoutMeetingPoint in src/handlers/index.ts.
          meetingPointId: 'fountain',
        }),
      }), context);
      expect(checkout.status).toBe(201);
      const checkoutUrl = requireStringProperty(await checkout.json(), 'checkoutUrl');
      const sessionId = new URL(checkoutUrl, 'http://localhost:4321').searchParams.get('session_id');
      if (!sessionId) throw new Error('Smoke checkout did not return a session_id');

      const held = await context.repo.getBookingBySessionId(sessionId);
      if (!held) throw new Error('Smoke checkout did not persist its booking');
      await expect(context.providers.payments.getSession(sessionId)).resolves.toMatchObject({
        status: 'complete',
        paymentStatus: 'paid',
        amountTotal: held.priceCents,
        currency: context.config.business.currency,
      });

      const status = await handleStatus(new Request(
        `http://localhost:4321/api/booking/status?session_id=${encodeURIComponent(sessionId)}`,
      ), context);
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({ status: 'confirmed' });

      const confirmed = await context.repo.getBookingById(held.id);
      if (!confirmed) throw new Error('Smoke booking disappeared after confirmation');
      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.cancelToken).not.toMatch(/^nohash:/);
      expect(confirmed.operatorToken).not.toMatch(/^nohash:/);

      const email = emailSpy.mock.calls.map(([, detail]) => detail).find(isDemoEmail);
      if (!email) throw new Error('Smoke confirmation did not emit management URLs');
      expect(email.customerManageUrl).not.toContain('nohash:');
      expect(email.operatorManageUrl).not.toContain('nohash:');
      expect(new URL(email.customerManageUrl).searchParams.get('token')).toBe(confirmed.cancelToken);
      expect(new URL(email.operatorManageUrl).searchParams.get('token')).toBe(confirmed.operatorToken);

      const manage = await handleManage(new Request(
        `http://localhost:4321/api/booking/manage?token=${encodeURIComponent(confirmed.operatorToken)}`,
      ), context);
      expect(manage.status).toBe(200);
      await expect(manage.json()).resolves.toMatchObject({ role: 'operator' });

      const admin = await handleAdminGet(new Request('http://localhost:4321/api/booking/admin'), context);
      expect(admin.status).toBe(200);
      await expect(admin.text()).resolves.toContain(
        `/booking/manage?token=${encodeURIComponent(confirmed.operatorToken)}`,
      );
    } finally {
      emailSpy.mockRestore();
    }
  });
});
