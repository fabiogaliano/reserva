import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { confirmBookingFromPayment } from '../../src/confirmation';
import { createReservaContext } from '../../src/context';
import type { Booking } from '../../src/core/booking';
import type { BookingRepository } from '../../src/repo';
import { config } from '../fixtures';
import { providers } from '../fakes';
import { seedHold } from './seed';

// The confirmation lease and the outbox rows it drains, against real D1: the lease fence is SQL
// (the claim and the resolve each match the lease token), so a fake repository would only prove itself.

const db = (env as unknown as { RESERVA_DB: D1Database }).RESERVA_DB;

beforeEach(async () => {
  for (const table of ['operational_incidents', 'side_effect_operations', 'refund_operations', 'bookings']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

function seedPaidHold(repo: BookingRepository, id: string): Promise<Booking> {
  return seedHold(repo, {
    id, reference: `BKT-2026-${id}`, serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
    startsAt: '2026-09-20T09:00:00.000Z', endsAt: '2026-09-20T10:00:00.000Z', locale: 'en',
    priceMinor: 12000, currency: 'eur', holdExpiresAt: '2026-08-14T10:35:00.000Z',
    cancelToken: `cancel-${id}`, operatorToken: `operator-${id}`,
    createdAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z',
  });
}

async function owedFamilies(bookingId: string): Promise<string[]> {
  const rows = await db.prepare('SELECT family FROM side_effect_operations WHERE booking_id = ?').bind(bookingId).all<{ family: string }>();
  return rows.results.map((row) => row.family);
}

describe('payment confirmation delivery against real D1', () => {
  it('owes no calendar event when no calendar is configured (every confirmation used to record and settle one without a call)', async () => {
    const { calendar: _noCalendar, ...withoutCalendar } = providers();
    const context = createReservaContext({
      config, db, clock: () => new Date('2026-08-14T10:05:00.000Z'), logger: {}, providers: withoutCalendar,
    });
    const hold = await seedPaidHold(context.repo, 'no-calendar');

    await expect(confirmBookingFromPayment(context, hold, 'pi_no_calendar')).resolves.toMatchObject({ status: 'confirmed' });

    const families = await owedFamilies(hold.id);
    expect(families).toContain('email_confirmation');
    expect(families).not.toContain('calendar_create');
  });

  it('records a calendar event once when the lease lapses during a slow call nobody takes over (the event used to be created again)', async () => {
    let now = new Date('2026-08-14T10:05:00.000Z');
    const created: string[] = [];
    const context = createReservaContext({
      config, db, clock: () => now, logger: {},
      providers: providers({
        calendar: {
          listEvents: async () => [],
          createEvent: async (booking) => {
            // Longer than the five-minute confirmation lease.
            now = new Date(now.getTime() + 6 * 60_000);
            created.push(booking.id);
            return `event-${created.length}`;
          },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });
    const hold = await seedPaidHold(context.repo, 'slow-calendar');

    await expect(confirmBookingFromPayment(context, hold, 'pi_slow_calendar')).resolves.toMatchObject({ status: 'confirmed' });
    // What a later status poll does: drain whatever the booking still owes.
    await confirmBookingFromPayment(context, hold, 'pi_slow_calendar');

    expect(created).toEqual([hold.id]);
    await expect(context.repo.getBookingById(hold.id)).resolves.toMatchObject({ calendarEventId: 'event-1' });
  });
});
