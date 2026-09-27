import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository } from '../../src/repo';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const db = (env as unknown as TestEnv).RESERVA_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM bookings').run();
});

// Migration 0005 widened the family CHECK; a reschedule's calendar sync is only durable if real D1
// accepts the row, once per reschedule version, in the same batch as the move.
describe('calendar_patch outbox rows on real D1', () => {
  it('records one calendar_patch row per reschedule, keyed by the reschedule version', async () => {
    const id = 'calendar-patch-outbox';
    await repo.insertHold({
      id,
      reference: 'BKT-2026-900',
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: `cancel-${id}`,
      operatorToken: `operator-${id}`,
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    await repo.transitionToConfirmed(id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });

    const move = (from: string, to: string, updatedAt: string) => repo.rescheduleWithCapacity(id, {
      expectedStatus: 'confirmed',
      expectedStartsAt: from,
      startsAt: to,
      endsAt: new Date(Date.parse(to) + 3_600_000).toISOString(),
      rescheduledFrom: from,
      updatedAt,
      now: updatedAt,
      occupancyUnits: 1,
      occupancyEndsAt: new Date(Date.parse(to) + 5_400_000).toISOString(),
      localDate: to.slice(0, 10),
      defaultCapacity: 2,
      mutationSideEffects: [{ family: 'calendar_patch', eventPayloadJson: null, eventIdPrefix: null }],
    });
    expect(await move('2026-08-01T09:00:00.000Z', '2026-08-02T09:00:00.000Z', '2026-07-21T11:00:00.000Z')).toMatchObject({ startsAt: '2026-08-02T09:00:00.000Z' });
    expect(await move('2026-08-02T09:00:00.000Z', '2026-08-03T09:00:00.000Z', '2026-07-21T12:00:00.000Z')).toMatchObject({ startsAt: '2026-08-03T09:00:00.000Z' });

    const rows = (await repo.listSideEffectOperations(id)).filter((row) => row.family === 'calendar_patch');
    expect(rows.map((row) => [row.discriminator, row.status])).toEqual([['1', 'pending'], ['2', 'pending']]);
  });
});
