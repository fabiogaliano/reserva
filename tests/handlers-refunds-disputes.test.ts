import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import type { Booking } from '../src/core/booking';
import type { BookingEventHookArgs, PaymentEventParsed } from '../src/core/events';
import { handlePaymentWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

// Delivers queued payment events one at a time at a chosen instant, so a test can replay the
// provider's deliveries in any order and read the booking the repository keeps.
function webhookHarness(seed: Booking) {
  const repo = fakeRepository([seed]);
  const queue: PaymentEventParsed[] = [];
  const pending: Promise<unknown>[] = [];
  const emails: string[] = [];
  const hookEvents: string[] = [];
  const warnings: string[] = [];
  let now = '2026-06-14T08:00:00.000Z';
  const context = createReservaContext({
    config,
    db: {} as D1Database,
    repo,
    clock: () => new Date(now),
    waitUntil: (promise) => pending.push(promise),
    logger: { warn: (message) => warnings.push(message), error: () => undefined },
    providers: providers({
      payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => {
          const next = queue.shift();
          if (!next) throw new Error('no event queued');
          return next;
        },
        getSession: async () => ({ status: 'open' }),
        refund: async () => { throw new Error('a refund webhook never issues a refund'); },
      },
      email: {
        send: async () => undefined,
        recipientsForEvent: (event) => (event === 'payment.dispute_created' ? ['owner'] : ['customer', 'owner']),
        sendToRecipient: async (recipient, event) => { emails.push(`${recipient}:${event}`); },
      },
    }),
    hooks: [{ name: 'ops', handler: async (...args: BookingEventHookArgs) => { hookEvents.push(args[0]); } }],
  });
  const deliver = async (event: PaymentEventParsed, at?: string) => {
    if (at !== undefined) now = at;
    queue.push(event);
    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    await Promise.all(pending);
  };
  return { repo, deliver, emails, hookEvents, warnings, row: () => repo.rows.get(seed.id)! };
}

describe('refund totals from the payment webhook', () => {
  const seeded = booking({ id: 'b-refund-total', paymentRef: 'pi_refund_total', priceMinor: 10000 });
  const refunded = (id: string, amountRefunded: number): PaymentEventParsed => ({
    id, type: 'refunded', paymentRef: 'pi_refund_total', amountCaptured: 10000, amountRefunded,
  });

  it('records a partial refund as the running total and leaves the booking confirmed', async () => {
    const { deliver, row, repo } = webhookHarness(seeded);

    await deliver(refunded('evt_first_partial', 2500));
    expect(row()).toMatchObject({ status: 'confirmed', amountRefundedMinor: 2500, updatedAt: seeded.updatedAt });

    await deliver(refunded('evt_second_partial', 4000));
    expect(row()).toMatchObject({ status: 'confirmed', amountRefundedMinor: 4000 });
    // A dashboard refund Reserva did not issue gets no operation row; Stripe keeps the per-refund ledger.
    expect(repo.refundOperations.get(seeded.id)).toBeUndefined();
  });

  // Stripe reports the cumulative amount with no refund id, so the only safe merge is the maximum.
  it('never lowers the total when an earlier refund’s event arrives after a later one', async () => {
    const { deliver, row } = webhookHarness(seeded);

    await deliver(refunded('evt_later', 6000));
    await deliver(refunded('evt_earlier', 2500));
    expect(row()).toMatchObject({ status: 'confirmed', amountRefundedMinor: 6000 });
  });

  it('records the full total and keeps the cancel transition when the refunds reach the captured amount', async () => {
    const { deliver, row, repo } = webhookHarness(seeded);

    await deliver(refunded('evt_partial', 3000));
    await deliver(refunded('evt_rest', 10000), '2026-06-14T09:00:00.000Z');
    expect(row()).toMatchObject({
      status: 'cancelled', cancelledBy: 'operator', cancelledAt: '2026-06-14T09:00:00.000Z', amountRefundedMinor: 10000,
    });
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ choice: 'full', status: 'succeeded', amountCents: 10000 });

    // The partial's event, delayed past the full refund, neither lowers the total nor revives the booking.
    await deliver(refunded('evt_partial_late', 3000));
    expect(row()).toMatchObject({ status: 'cancelled', amountRefundedMinor: 10000 });
  });

  it('ignores a refund on a payment no booking owns', async () => {
    const { deliver, row } = webhookHarness(seeded);

    await deliver({ id: 'evt_foreign', type: 'refunded', paymentRef: 'pi_someone_else', amountCaptured: 5000, amountRefunded: 5000 });
    expect(row()).toEqual(seeded);
  });
});

describe('dispute status from the payment webhook', () => {
  const seeded = booking({ id: 'b-dispute-status', paymentRef: 'pi_dispute_status' });
  const created: PaymentEventParsed = { id: 'evt_dispute_created', type: 'dispute_created', paymentRef: 'pi_dispute_status' };
  const closed = (disputeOutcome?: 'won' | 'lost'): PaymentEventParsed => ({
    id: `evt_dispute_closed_${disputeOutcome ?? 'unknown'}`, type: 'dispute_closed', paymentRef: 'pi_dispute_status',
    ...(disputeOutcome ? { disputeOutcome } : {}),
  });

  it('opens on creation, then takes the outcome on close without moving the date', async () => {
    const { deliver, row, emails, hookEvents } = webhookHarness(seeded);

    await deliver(created, '2026-06-14T08:00:00.000Z');
    expect(row()).toMatchObject({ status: 'confirmed', disputedAt: '2026-06-14T08:00:00.000Z', disputeStatus: 'open' });
    expect(emails).toEqual(['owner:payment.dispute_created']);
    expect(hookEvents).toEqual(['payment.dispute_created']);

    await deliver(closed('won'), '2026-08-01T10:00:00.000Z');
    expect(row()).toMatchObject({ disputedAt: '2026-06-14T08:00:00.000Z', disputeStatus: 'won' });
  });

  it('keeps the outcome when the close is delivered before the event that opened the dispute', async () => {
    const { deliver, row, emails } = webhookHarness(seeded);

    await deliver(closed('lost'), '2026-08-01T10:00:00.000Z');
    expect(row()).toMatchObject({ disputedAt: '2026-08-01T10:00:00.000Z', disputeStatus: 'lost' });

    await deliver(created, '2026-08-01T10:05:00.000Z');
    expect(row()).toMatchObject({ disputedAt: '2026-08-01T10:00:00.000Z', disputeStatus: 'lost' });
    // The late creation still notifies the owner: it is the only dispute mail there is.
    expect(emails).toEqual(['owner:payment.dispute_created']);
  });

  it('lets the last close win when a payment is disputed twice and the provider gives no creation time', async () => {
    const { deliver, row } = webhookHarness(seeded);

    await deliver(created, '2026-06-14T08:00:00.000Z');
    await deliver(closed('won'));
    await deliver({ ...created, id: 'evt_second_dispute_created' }, '2026-07-01T08:00:00.000Z');
    // Without the provider's creation time a second opening can't be told from a redelivery, so it
    // does not reopen a recorded outcome.
    expect(row()).toMatchObject({ disputedAt: '2026-06-14T08:00:00.000Z', disputeStatus: 'won' });
    await deliver(closed('lost'));
    expect(row()).toMatchObject({ disputedAt: '2026-06-14T08:00:00.000Z', disputeStatus: 'lost' });
  });

  // Stripe retries a failed delivery for days and can deliver the close first; the dispute's own
  // creation time is the same on every event, so neither shifts the date the admin shows.
  it('dates the dispute from the provider’s creation time, whatever the delivery order', async () => {
    const openedAt = '2026-06-10T09:30:00.000Z';
    const { deliver, row } = webhookHarness(seeded);

    await deliver({ ...closed('lost'), disputeCreatedAt: openedAt }, '2026-08-01T10:00:00.000Z');
    await deliver({ ...created, disputeCreatedAt: openedAt }, '2026-08-03T10:00:00.000Z');
    expect(row()).toMatchObject({ disputedAt: openedAt, disputeStatus: 'lost' });
  });

  // A won dispute reads as payable, so a later chargeback on the same payment must show as open.
  it('reopens a won dispute when a later dispute opens on the same payment', async () => {
    const first = '2026-06-10T09:30:00.000Z';
    const second = '2026-07-20T11:00:00.000Z';
    const { deliver, row, emails } = webhookHarness(seeded);

    await deliver({ ...created, disputeCreatedAt: first });
    await deliver({ ...closed('won'), disputeCreatedAt: first });
    // A redelivery of the first dispute's opening changes nothing.
    await deliver({ ...created, disputeCreatedAt: first });
    expect(row()).toMatchObject({ disputedAt: first, disputeStatus: 'won' });

    await deliver({ ...created, id: 'evt_second_dispute_created', disputeCreatedAt: second });
    expect(row()).toMatchObject({ disputedAt: second, disputeStatus: 'open' });
    expect(emails).toEqual(['owner:payment.dispute_created', 'owner:payment.dispute_created']);

    await deliver({ ...closed('lost'), id: 'evt_second_dispute_closed', disputeCreatedAt: second });
    expect(row()).toMatchObject({ disputedAt: second, disputeStatus: 'lost' });
  });

  it('keeps a later dispute’s outcome when its close arrives before its opening', async () => {
    const first = '2026-06-10T09:30:00.000Z';
    const second = '2026-07-20T11:00:00.000Z';
    const { deliver, row } = webhookHarness(seeded);

    await deliver({ ...created, disputeCreatedAt: first });
    await deliver({ ...closed('won'), disputeCreatedAt: first });
    await deliver({ ...closed('lost'), id: 'evt_second_dispute_closed', disputeCreatedAt: second });
    await deliver({ ...created, id: 'evt_second_dispute_created', disputeCreatedAt: second });
    expect(row()).toMatchObject({ disputedAt: second, disputeStatus: 'lost' });
  });

  it('warns and changes nothing when a close names a payment no booking owns', async () => {
    const { deliver, row, warnings } = webhookHarness(seeded);

    await deliver({ ...closed('won'), paymentRef: 'pi_someone_else' });
    expect(row()).toEqual(seeded);
    expect(warnings).toContain('payment dispute closed for no known booking');
  });

  it('records a close without a known outcome as an open dispute, and warns', async () => {
    const { deliver, row, warnings } = webhookHarness(seeded);

    await deliver(closed(), '2026-08-01T10:00:00.000Z');
    expect(row()).toMatchObject({ disputedAt: '2026-08-01T10:00:00.000Z', disputeStatus: 'open' });
    expect(warnings).toContain('payment dispute closed without a known outcome');
  });

  it('sends no email, emits no event and leaves the booking untouched when a dispute closes', async () => {
    const { deliver, row, emails, hookEvents, repo } = webhookHarness(seeded);
    await deliver(created);
    const before = structuredClone(row());
    const operationsBefore = [...repo.sideEffectOperations.keys()].sort();

    await deliver(closed('lost'));
    expect(row()).toEqual({ ...before, disputeStatus: 'lost' });
    expect(emails).toEqual(['owner:payment.dispute_created']);
    expect(hookEvents).toEqual(['payment.dispute_created']);
    expect([...repo.sideEffectOperations.keys()].sort()).toEqual(operationsBefore);
  });
});
