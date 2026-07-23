import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { ConfirmationInProgressError, confirmBookingFromPayment } from '../src/confirmation';
import { createBookkitContext, type BookkitProviders } from '../src/context';
import { handleStatus, handleStripeWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

function paidWebhookProviders(bookingId: string, sessionId: string, overrides: Partial<BookkitProviders> = {}) {
  return providers({
    payments: {
      createCheckout: async () => ({ url: '', sessionId: '' }),
      parseWebhook: async () => ({
        id: 'evt_outbox', type: 'checkout.session.completed', bookingId, sessionId,
        paymentIntent: 'pi_outbox', paid: true, amountCaptured: 10000, currency: config.business.currency,
      }),
      getSession: async () => ({ status: 'open' }),
      refund: async () => ({ refundId: 're_outbox', amountCents: 0 }),
    },
    ...overrides,
  });
}

describe('confirmation side-effect outbox', () => {
  it('retries a calendar write failure without creating a second deterministic Calendar event', async () => {
    const seeded = booking({ id: '0a1b2c3d-4e5f-6789-a0b1-c2d3e4f5a6b7', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_outbox_calendar' });
    const repo = fakeRepository([seeded]);
    const resolveOperation = repo.resolveSideEffectOperation;
    let failSuccessWrite = true;
    repo.resolveSideEffectOperation = async (input) => {
      if (input.kind === 'calendar_create' && input.status === 'succeeded' && failSuccessWrite) {
        failSuccessWrite = false;
        throw new Error('D1 write failed after Calendar accepted the event');
      }
      return resolveOperation(input);
    };
    const eventIds = new Set<string>();
    let calendarCalls = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_outbox_calendar', {
        calendar: {
          listEvents: async () => [],
          createEvent: async (item) => {
            calendarCalls += 1;
            const eventId = item.id.replaceAll('-', '');
            eventIds.add(eventId);
            return eventId;
          },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 500 });
    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });

    expect(calendarCalls).toBe(2);
    expect(eventIds).toEqual(new Set([seeded.id.replaceAll('-', '')]));
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_create`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('records an email attempt before send and resumes its failed operation on webhook redelivery', async () => {
    const seeded = booking({ id: 'b-outbox-email', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_outbox_email' });
    const repo = fakeRepository([seeded]);
    const resolveOperation = repo.resolveSideEffectOperation;
    let failSuccessWrite = true;
    repo.resolveSideEffectOperation = async (input) => {
      if (input.kind === 'email_confirmation' && input.status === 'succeeded' && failSuccessWrite) {
        failSuccessWrite = false;
        throw new Error('D1 write failed after Brevo accepted the email');
      }
      return resolveOperation(input);
    };
    let emailCalls = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_outbox_email', {
        email: { send: async () => { emailCalls += 1; } },
      }),
    });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 500 });
    expect(repo.sideEffectOperations.get(`${seeded.id}:email_confirmation`)).toMatchObject({ status: 'failed', attemptedAt: expect.any(String), attemptCount: 1 });
    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });

    expect(emailCalls).toBe(2);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email_confirmation`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('lets a status poll resume a confirmed booking with incomplete fulfillment', async () => {
    const seeded = booking({ id: 'b-status-resume', status: 'confirmed', stripeSessionId: 'cs_status_resume', calendarSynced: false, emailSynced: true });
    const repo = fakeRepository([seeded]);
    const createdAt = '2026-06-14T08:00:00.000Z';
    repo.sideEffectOperations.set(`${seeded.id}:calendar_create`, {
      bookingId: seeded.id, kind: 'calendar_create', status: 'pending', providerResultId: null,
      attemptCount: 0, attemptedAt: null, resolvedAt: null, error: null, createdAt, updatedAt: createdAt,
    });
    repo.sideEffectOperations.set(`${seeded.id}:email_confirmation`, {
      bookingId: seeded.id, kind: 'email_confirmation', status: 'succeeded', providerResultId: null,
      attemptCount: 1, attemptedAt: createdAt, resolvedAt: createdAt, error: null, createdAt, updatedAt: createdAt,
    });
    let calendarCalls = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCalls += 1; return 'calendar-status-resume'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/status?session_id=cs_status_resume'), context);

    expect(response.status).toBe(200);
    expect(calendarCalls).toBe(1);
    expect(repo.rows.get(seeded.id)).toMatchObject({ calendarSynced: true, emailSynced: true });
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_create`)).toMatchObject({ status: 'succeeded' });
  });

  it('records an oversell incident when an expired paid hold cannot be capacity-checked', async () => {
    const seeded = booking({ id: 'b-expired-capacity-outage', status: 'expired', holdExpiresAt: null });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        calendar: {
          listEvents: async () => { throw new Error('Calendar unavailable'); },
          createEvent: async () => 'cal-capacity-outage',
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    await expect(confirmBookingFromPayment(context, seeded, 'pi-capacity-outage')).resolves.toMatchObject({ status: 'confirmed' });
    expect(repo.sideEffectOperations.get(`${seeded.id}:oversell`)).toMatchObject({
      kind: 'oversell',
      status: 'succeeded',
    });
  });

  it('asks Stripe to retry when a pre-confirmation lease-fenced batch loses before confirming', async () => {
    const seeded = booking({ id: 'b-pre-confirmation-lease-loss', status: 'expired', holdExpiresAt: null });
    const repo = fakeRepository([seeded]);
    repo.confirmWithSideEffectOperations = async () => null;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    await expect(confirmBookingFromPayment(context, seeded, 'pi-lease-loss')).rejects.toBeInstanceOf(ConfirmationInProgressError);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'expired' });
  });

  it('fills payment details when a webhook redelivers after status confirmation', async () => {
    const seeded = booking({
      id: 'b-status-then-webhook',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripePaymentIntent: null,
      customerEmail: null,
    });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({
            id: 'evt-status-then-webhook',
            type: 'checkout.session.completed',
            bookingId: seeded.id,
            ...(seeded.stripeSessionId !== null ? { sessionId: seeded.stripeSessionId } : {}),
            paymentIntent: 'pi-status-then-webhook',
            paid: true,
            amountCaptured: seeded.priceCents,
            currency: config.business.currency,
            customerEmail: 'webhook@example.test',
          }),
          getSession: async () => ({ id: 'cs_1', status: 'complete', paymentStatus: 'paid', amountTotal: seeded.priceCents, currency: config.business.currency }),
          refund: async () => ({ refundId: 're-status-then-webhook', amountCents: 0 }),
        },
      }),
    });

    await expect(handleStatus(new Request(`https://example.test/status?session_id=${seeded.stripeSessionId}`), context)).resolves.toMatchObject({ status: 200 });
    expect(repo.rows.get(seeded.id)).toMatchObject({ stripePaymentIntent: null, customerEmail: null });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });
    expect(repo.rows.get(seeded.id)).toMatchObject({
      stripePaymentIntent: 'pi-status-then-webhook',
      customerEmail: 'webhook@example.test',
    });
  });

  it('rejects a lease-loser’s late operation write after another caller renews the expired lease', async () => {
    const seeded = booking({ id: 'b-lease-fence', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    let now = new Date('2026-06-14T08:00:00.000Z');
    let releaseCalendar = (): void => undefined;
    const calendarBlocked = new Promise<void>((resolve) => { releaseCalendar = resolve; });
    let calendarStarted = (): void => undefined;
    const firstCalendarStarted = new Promise<void>((resolve) => { calendarStarted = resolve; });
    let calendarCalls = 0;
    const sharedProviders = providers({
      calendar: {
        listEvents: async () => [],
        createEvent: async () => {
          calendarCalls += 1;
          if (calendarCalls === 1) {
            calendarStarted();
            await calendarBlocked;
          }
          return seeded.id.replaceAll('-', '');
        },
        patchEvent: async () => undefined,
        deleteEvent: async () => undefined,
      },
    });
    const context = () => createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => now,
      providers: sharedProviders,
    });

    const first = confirmBookingFromPayment(context(), seeded, 'pi_lease');
    await firstCalendarStarted;
    now = new Date('2026-06-14T08:06:00.000Z');
    await expect(confirmBookingFromPayment(context(), seeded, 'pi_lease')).resolves.toMatchObject({ status: 'confirmed' });
    releaseCalendar();

    await expect(first).rejects.toBeInstanceOf(ConfirmationInProgressError);
    expect(repo.rows.get(seeded.id)).toMatchObject({ calendarEventId: seeded.id.replaceAll('-', ''), calendarSynced: true });
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_create`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });
});
