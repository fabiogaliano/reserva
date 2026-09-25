import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext, type ReservaLogger } from '../src/context';
import type { ResolvedClientConfig } from '../src/core/config';
import type { EmailBookingEvent } from '../src/core/events';
import { renderDefaultEmail } from '../src/email';
import { scheduledHandler } from '../src/reconciliation';
import { booking, config } from './fixtures';
import { fakeRepository, providers, seedSideEffectOperation, sideEffectOperation, type FakeRepository } from './fakes';

// Admin settings overrides live in D1, not in the file config the runtime module hands the cron.
// These pin that the scheduled sweep reads the same merged config a web request does.

const clock = () => new Date('2026-08-14T10:00:00.000Z');

interface SentEmail { event: EmailBookingEvent; config: ResolvedClientConfig }

async function runCron(repo: FakeRepository, logger?: ReservaLogger): Promise<SentEmail[]> {
  const sent: SentEmail[] = [];
  const runtime = {
    createContext: () => createReservaContext({
      config, db: {} as D1Database, repo, clock,
      ...(logger ? { logger } : {}),
      providers: providers({
        email: { send: async (event, _booking, sentConfig) => { sent.push({ event, config: sentConfig }); } },
        alerts: { send: async () => undefined },
      }),
    }),
  };
  await scheduledHandler(runtime)({} as ScheduledController, {}, {} as ExecutionContext);
  return sent;
}

const reminderRow = (repo: FakeRepository, bookingId: string, startsAt: string) =>
  sideEffectOperation(repo, bookingId, { family: 'email', event: 'booking.reminder', discriminator: startsAt });

describe('scheduledHandler with admin setting overrides', () => {
  it('does not arm a reminder the file config would arm when booking.reminderHoursBefore is overridden to 0', async () => {
    const startsAt = '2026-08-14T22:00:00.000Z';
    const seeded = booking({ id: 'cron-reminder-off', startsAt, endsAt: '2026-08-14T23:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    repo.settings.set('booking.reminderHoursBefore', '0');

    const sent = await runCron(repo);

    expect(reminderRow(repo, seeded.id, startsAt)).toBeUndefined();
    expect(sent.filter((email) => email.event === 'booking.reminder')).toEqual([]);
  });

  it('arms a reminder the file config would not arm when booking.reminderHoursBefore is overridden to 48', async () => {
    // 36h out: outside the file's 24h window, inside the operator's 48h one.
    const startsAt = '2026-08-15T22:00:00.000Z';
    const seeded = booking({ id: 'cron-reminder-on', startsAt, endsAt: '2026-08-15T23:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    repo.settings.set('booking.reminderHoursBefore', '48');

    const sent = await runCron(repo);

    expect(reminderRow(repo, seeded.id, startsAt)).toMatchObject({ status: 'succeeded' });
    expect(sent.map((email) => email.event)).toContain('booking.reminder');
  });

  it('renders a cron-retried confirmation email with the overridden booking.cancelCutoffHours', async () => {
    const seeded = booking({ id: 'cron-confirmation-retry', startsAt: '2026-08-20T09:00:00.000Z', endsAt: '2026-08-20T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    seedSideEffectOperation(repo, seeded.id, { family: 'email', event: 'booking.confirmed' }, {
      status: 'pending', createdAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z',
    });
    repo.settings.set('booking.cancelCutoffHours', '72');

    const sent = await runCron(repo);

    const confirmation = sent.find((email) => email.event === 'booking.confirmed');
    expect(confirmation?.config.booking.cancelCutoffHours).toBe(72);
    const rendered = renderDefaultEmail({
      event: 'booking.confirmed', booking: seeded, config: confirmation!.config, locale: 'en', recipient: 'customer',
      customerManageUrl: 'https://example.test/booking/manage?token=cancel-token', operatorManageUrl: 'https://example.test/booking/manage?token=operator-token',
      startsAtLocal: '20 Aug 2026, 10:00',
    });
    // 72h before 2026-08-20T09:00Z is 17 August, 10:00 in Lisbon; the file's 24h would say 19 August.
    expect(rendered.text).toContain('Free cancellation until 17 August');
    expect(rendered.text).not.toContain('19 August');
  });

  it('degrades an invalid override row to the file value and warns, instead of failing the sweep', async () => {
    const startsAt = '2026-08-14T22:00:00.000Z';
    const seeded = booking({ id: 'cron-invalid-override', startsAt, endsAt: '2026-08-14T23:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    repo.settings.set('booking.reminderHoursBefore', '-5');
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const logger: ReservaLogger = { info: () => undefined, warn: (message, data) => { warnings.push({ message, ...(data ? { data } : {}) }); }, error: () => undefined };

    await runCron(repo, logger);

    expect(reminderRow(repo, seeded.id, startsAt)).toMatchObject({ status: 'succeeded' });
    expect(warnings).toContainEqual(expect.objectContaining({
      message: 'reserva.settings.invalid_override',
      data: expect.objectContaining({ key: 'booking.reminderHoursBefore' }),
    }));
  });
});
