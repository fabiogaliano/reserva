import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import smokeRuntime from '../../examples/smoke-site/src/runtime';
import { handleCheckout, handleManage, handleStatus } from '../../src/handlers';

// Plan 024 (step 4): the workers-level end-to-end proof — real D1, the real smoke runtime, and
// riverCruise's real declared metadata fields (examples/smoke-site/src/config.ts: a required
// `text` field and a `select` field, plan 024's done criteria) — that consumer-declared metadata
// survives checkout -> D1 -> confirmation (self-healed through /status) -> both manage-page roles.
// The webhook envelope's raw passthrough and the email renderer's labeled rows are proven at unit
// level (tests/booking-events.test.ts, tests/providers-email.test.ts) against real signing/
// rendering, which this fixture's dev-only providers don't do (see examples/smoke-site/src/
// runtime.ts's email provider: it records an outbox entry, not real rendered HTML).

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

function nextSmokeSlot(): string {
  const slot = new Date();
  slot.setUTCDate(slot.getUTCDate() + 1);
  slot.setUTCHours(11, 0, 0, 0);
  return slot.toISOString();
}

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
});

describe('consumer-declared metadata through the real smoke runtime + D1 (plan 024)', () => {
  it('survives checkout -> D1 -> self-healed confirmation -> both manage-page roles, labeled and typed', async () => {
    const request = new Request('http://localhost:4321/api/booking/checkout');
    const context = await smokeRuntime.createContext({
      request,
      locals: { env: {
        BOOKKIT_DB: db,
        BOOKKIT_TOKEN_ENC_KEY: 'local-demo-token-encryption-key',
        BOOKKIT_OPERATOR_SECRET: 'local-operator-secret',
      } },
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const checkout = await handleCheckout(new Request(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceSlug: 'riverCruise',
          start: nextSmokeSlot(),
          quantity: 2,
          locale: 'en',
          metadata: { dietary_notes: 'Vegan, no nuts', seat_pref: 'window' },
        }),
      }), context);
      expect(checkout.status).toBe(201);
      const checkoutUrl = requireStringProperty(await checkout.json(), 'checkoutUrl');
      const sessionRef = new URL(checkoutUrl, 'http://localhost:4321').searchParams.get('session_id');
      if (!sessionRef) throw new Error('Smoke checkout did not return a session_id');

      // Real D1 round trip: the JSON survives the actual INSERT/SELECT, not a fake's in-memory map.
      const held = await context.repo.getBookingBySessionRef(sessionRef);
      if (!held) throw new Error('Smoke checkout did not persist its booking');
      expect(held.metadata).toEqual({ dietary_notes: 'Vegan, no nuts', seat_pref: 'window' });

      const status = await handleStatus(new Request(
        `http://localhost:4321/api/booking/status?session_id=${encodeURIComponent(sessionRef)}`,
      ), context);
      expect(status.status).toBe(200);
      const statusPayload = await status.json() as { status: string; booking: { metadataRows?: Array<{ key: string; label: string; value: unknown }> } };
      expect(statusPayload.status).toBe('confirmed');
      expect(statusPayload.booking.metadataRows).toEqual([
        { key: 'dietary_notes', label: 'Dietary notes', value: 'Vegan, no nuts' },
        { key: 'seat_pref', label: 'Seat preference', value: 'Window seat' },
      ]);

      const confirmed = await context.repo.getBookingById(held.id);
      if (!confirmed) throw new Error('Smoke booking disappeared after confirmation');
      expect(confirmed.status).toBe('confirmed');

      const customerManage = await handleManage(new Request(
        `http://localhost:4321/api/booking/manage?token=${encodeURIComponent(confirmed.cancelToken)}`,
      ), context);
      expect(customerManage.status).toBe(200);
      const customerPayload = await customerManage.json() as { role: string; booking: { metadataRows?: unknown } };
      expect(customerPayload.role).toBe('customer');
      expect(customerPayload.booking.metadataRows).toEqual(statusPayload.booking.metadataRows);

      const operatorManage = await handleManage(new Request(
        `http://localhost:4321/api/booking/manage?token=${encodeURIComponent(confirmed.operatorToken)}`,
      ), context);
      expect(operatorManage.status).toBe(200);
      const operatorPayload = await operatorManage.json() as { role: string; booking: { metadataRows?: unknown } };
      expect(operatorPayload.role).toBe('operator');
      expect(operatorPayload.booking.metadataRows).toEqual(statusPayload.booking.metadataRows);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('rejects a checkout missing the required dietary_notes field before ever touching D1', async () => {
    const request = new Request('http://localhost:4321/api/booking/checkout');
    const context = await smokeRuntime.createContext({
      request,
      locals: { env: {
        BOOKKIT_DB: db,
        BOOKKIT_TOKEN_ENC_KEY: 'local-demo-token-encryption-key',
        BOOKKIT_OPERATOR_SECRET: 'local-operator-secret',
      } },
    });

    const checkout = await handleCheckout(new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceSlug: 'riverCruise',
        start: nextSmokeSlot(),
        quantity: 2,
        locale: 'en',
        metadata: { seat_pref: 'window' },
      }),
    }), context);
    expect(checkout.status).toBe(400);
    const body = await checkout.json() as { error: { message: string } };
    expect(body.error.message).toContain('dietary_notes');

    const rows = await db.prepare('SELECT COUNT(*) AS count FROM bookings').all<{ count: number }>();
    expect(Number(rows.results[0]?.count ?? 0)).toBe(0);
  });
});
