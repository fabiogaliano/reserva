import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import {
  handleCustomerCancel,
  handleCustomerReschedule,
  handleOperatorCancel,
  handleOperatorNoShow,
  handleOperatorReschedule,
  handlePaymentWebhook,
} from '../src/handlers';
import { booking, config } from './fixtures';
import { sideEffectOperationKey, type SideEffectOperationIdentity } from '../src/repo';
import { fakeRepository, providers, sideEffectOperation } from './fakes';

// BK-DATA-001: every status-changing handler now writes through a compare-and-set repo
// method. These tests force the exact race the CAS closes — a concurrent transition lands
// between the handler's in-memory read and its DB write — by hooking the fake repo's
// transition method to mutate the row (as if a racing request won) right before the real
// CAS runs. The stale caller must lose (409, row untouched by it) instead of corrupting the
// row with a mix of both transitions' fields.

const clock = () => new Date('2026-06-14T08:00:00.000Z');
const validNewStart = '2026-06-15T08:00:00.000Z';

function cancelRequest(token: string): Request {
  return new Request('https://example.test/api/booking/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

function rescheduleRequest(token: string, newStart: string): Request {
  return new Request('https://example.test/api/booking/reschedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newStart }),
  });
}

function operatorRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://example.test/api/booking/operator/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('stale compare-and-set transitions', () => {
  it('a customer cancel that loses a race to a concurrent operator no-show gets 409 instead of corrupting the row', async () => {
    const seeded = booking({ id: 'b-cancel-vs-noshow', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-cancel-vs-noshow' });
    const repo = fakeRepository([seeded]);
    const realTransition = repo.transitionToCancelled;
    repo.transitionToCancelled = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) repo.rows.set(id, { ...current, status: 'no_show', updatedAt: '2026-06-14T08:00:01.000Z' });
      return realTransition(id, input);
    };
    let deletes = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined, deleteEvent: async () => { deletes += 1; } } }),
    });

    const response = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('no_show');
    expect(row?.cancelledBy).toBeNull();
    expect(row?.cancelledAt).toBeNull();
    expect(deletes).toBe(0);
  });

  it('an operator cancel that loses a race to a concurrent no-show gets 409 instead of corrupting the row', async () => {
    const seeded = booking({ id: 'b-op-cancel-vs-noshow', calendarEventId: 'cal-op-cancel-vs-noshow' });
    const repo = fakeRepository([seeded]);
    const realTransition = repo.transitionToCancelled;
    repo.transitionToCancelled = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) repo.rows.set(id, { ...current, status: 'no_show', updatedAt: '2026-06-14T08:00:01.000Z' });
      return realTransition(id, input);
    };
    let deletes = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined, deleteEvent: async () => { deletes += 1; } } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('no_show');
    expect(row?.cancelledBy).toBeNull();
    expect(deletes).toBe(0);
  });

  it('an operator no-show that loses a race to a concurrent cancel gets 409 instead of corrupting the row', async () => {
    // The corrupted-row example from the spec: a losing no-show must never leave
    // status='no_show' while cancelled_at/cancelled_by are still set from the winner.
    const seeded = booking({ id: 'b-noshow-vs-cancel', status: 'confirmed', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T07:30:00.000Z' });
    const repo = fakeRepository([seeded]);
    const realTransition = repo.transitionToNoShow;
    repo.transitionToNoShow = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) repo.rows.set(id, { ...current, status: 'cancelled', cancelledAt: '2026-06-14T08:00:00.000Z', cancelledBy: 'customer' });
      return realTransition(id, input);
    };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(409);
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('customer');
  });

  it('a reschedule that loses a race to a concurrent cancel gets 409 instead of moving the row', async () => {
    const seeded = booking({ id: 'b-reschedule-vs-cancel', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    // BK-CAP-001: rescheduleWithToken now writes through rescheduleWithCapacity (the atomic
    // capacity-guarded UPDATE), not the old unconditional transitionReschedule — hook that entry
    // point so this still exercises the real CAS instead of silently no-op-ing.
    const realTransition = repo.rescheduleWithCapacity;
    repo.rescheduleWithCapacity = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) repo.rows.set(id, { ...current, status: 'cancelled', cancelledAt: '2026-06-14T08:00:00.000Z', cancelledBy: 'customer' });
      return realTransition(id, input);
    };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
    const row = repo.rows.get(seeded.id);
    expect(row?.startsAt).toBe(seeded.startsAt);
    expect(row?.status).toBe('cancelled');
  });

  it('an operator reschedule that loses a race to a concurrent cancel gets 409 instead of moving the row', async () => {
    // Mirrors the customer-reschedule-vs-cancel test above, but through the operator entrypoint
    // (handleOperatorReschedule) — both go through rescheduleWithToken, but the spec calls for a
    // stale-transition test per converted handler, and the operator one wasn't covered yet.
    const seeded = booking({ id: 'b-op-reschedule-vs-cancel', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    // BK-CAP-001: see the customer-reschedule-vs-cancel test above — hook the atomic
    // rescheduleWithCapacity entry point rescheduleWithToken now actually writes through.
    const realTransition = repo.rescheduleWithCapacity;
    repo.rescheduleWithCapacity = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) repo.rows.set(id, { ...current, status: 'cancelled', cancelledAt: '2026-06-14T08:00:00.000Z', cancelledBy: 'operator' });
      return realTransition(id, input);
    };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorReschedule(operatorRequest('reschedule', { operatorToken: seeded.operatorToken, newStart: validNewStart }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
    const row = repo.rows.get(seeded.id);
    expect(row?.startsAt).toBe(seeded.startsAt);
    expect(row?.status).toBe('cancelled');
  });

  it('a reschedule that loses a race to a concurrent reschedule gets 409 slot_unavailable instead of clobbering the winner', async () => {
    const seeded = booking({ id: 'b-reschedule-vs-reschedule', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    // BK-CAP-001: see the reschedule-vs-cancel test above — hook the atomic
    // rescheduleWithCapacity entry point rescheduleWithToken now actually writes through.
    const realTransition = repo.rescheduleWithCapacity;
    repo.rescheduleWithCapacity = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) {
        repo.rows.set(id, {
          ...current,
          startsAt: '2026-06-16T09:00:00.000Z',
          endsAt: '2026-06-16T10:00:00.000Z',
          rescheduledFrom: current.startsAt,
        });
      }
      return realTransition(id, input);
    };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('confirmed');
    expect(row?.startsAt).toBe('2026-06-16T09:00:00.000Z');
  });

  it('a charge.refunded cancellation that loses a race to a concurrent customer cancel drains only the winner’s retryable outbox', async () => {
    // calendarEventId: the winning customer-cancel transition below carries 'calendar_delete' in
    // its own mutationSideEffects (mirroring cancellationSideEffectSeeds in src/confirmation.ts),
    // so this also pins that the stale webhook's re-read-and-drain path picks up and resolves the
    // winner's calendar debt, not just its email/hook rows.
    const seeded = booking({ id: 'b-refund-vs-cancel', paymentRef: 'pi_refund_stale', calendarEventId: 'cal-refund-vs-cancel' });
    const repo = fakeRepository([seeded]);
    const realRefundTransition = repo.upsertRefundOperationAndTransitionToCancelled;
    const customerTransition = repo.transitionToCancelled;
    const getBookingById = repo.getBookingById;
    let rereads = 0;
    repo.getBookingById = async (id) => {
      rereads += 1;
      return getBookingById(id);
    };
    repo.upsertRefundOperationAndTransitionToCancelled = async (refund, id, input) => {
      await customerTransition(id, {
        expectedStatusIn: ['confirmed'],
        expectedStartsAt: seeded.startsAt,
        cancelledAt: '2026-06-14T08:00:00.000Z',
        cancelledBy: 'customer',
        updatedAt: '2026-06-14T08:00:00.000Z',
        mutationSideEffects: [
          { family: 'email', event: 'booking.cancelled_by_customer', eventPayloadJson: null, eventIdPrefix: null },
          { family: 'hook', name: 'ops', event: 'booking.cancelled_by_customer', eventPayloadJson: null, eventIdPrefix: null },
          { family: 'calendar_delete', eventPayloadJson: null, eventIdPrefix: null },
        ],
      });
      return realRefundTransition(refund, id, input);
    };
    const emailIdentity: SideEffectOperationIdentity = { family: 'email', event: 'booking.cancelled_by_customer' };
    const hookIdentity: SideEffectOperationIdentity = { family: 'hook', name: 'ops', event: 'booking.cancelled_by_customer' };
    const emails: string[] = [];
    const opsEvents: string[] = [];
    let emailAttempts = 0;
    let calendarDeletes = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_refund_stale',
            type: 'refunded',
            paymentRef: 'pi_refund_stale',
            amountCaptured: seeded.priceMinor,
            amountRefunded: seeded.priceMinor,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
        calendar: {
          listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined,
          deleteEvent: async () => { calendarDeletes += 1; },
        },
        email: {
          send: async (event) => {
            emails.push(event);
            emailAttempts += 1;
            if (emailAttempts === 1) throw new Error('email unavailable');
          },
        },
      }),
      hooks: [{ name: 'ops', durable: true, handler: async (event) => { opsEvents.push(event); } }],
    });
    const request = new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' });

    const first = await handlePaymentWebhook(request, context);
    expect(first.status).toBe(200);
    expect(rereads).toBe(1);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ choice: 'full', status: 'succeeded' });
    expect(emails).toEqual(['booking.cancelled_by_customer']);
    expect(opsEvents).toEqual(['booking.cancelled_by_customer']);
    expect(calendarDeletes).toBe(1);
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBeNull();
    expect(sideEffectOperation(repo, seeded.id, emailIdentity)).toMatchObject({ status: 'failed', attemptCount: 1 });
    expect(sideEffectOperation(repo, seeded.id, hookIdentity)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_delete' })).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect([...repo.sideEffectOperations.values()].map(sideEffectOperationKey).sort()).toEqual([
      'calendar_delete',
      'email:booking.cancelled_by_customer',
      'hook:ops:booking.cancelled_by_customer',
    ]);

    const second = await handlePaymentWebhook(request, context);
    expect(second.status).toBe(200);
    expect(emails).toEqual(['booking.cancelled_by_customer', 'booking.cancelled_by_customer']);
    expect(opsEvents).toEqual(['booking.cancelled_by_customer']);
    expect(calendarDeletes).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, emailIdentity)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('a payment confirmation that loses a race to a concurrent operator cancel does not resurrect the booking', async () => {
    const seeded = booking({
      id: 'b-confirm-vs-cancel',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_confirm_stale',
      paymentRef: null,
    });
    const repo = fakeRepository([seeded]);
    const realTransition = repo.confirmWithSideEffectOperations;
    repo.confirmWithSideEffectOperations = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) {
        repo.rows.set(id, {
          ...current,
          status: 'cancelled',
          cancelledAt: '2026-06-14T08:00:00.000Z',
          cancelledBy: 'operator',
          holdExpiresAt: null,
        });
      }
      return realTransition(id, input);
    };
    let calendarCreates = 0;
    let emails = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_confirm_stale',
            type: 'checkout_completed',
            bookingId: seeded.id,
            sessionRef: 'cs_confirm_stale',
            paymentRef: 'pi_confirm_stale',
            paid: true,
            amountCaptured: seeded.priceMinor,
            currency: config.business.currency,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal_confirm_stale'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
        email: { send: async () => { emails += 1; } },
      }),
    });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(503);
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('operator');
    expect(calendarCreates).toBe(0);
    expect(emails).toBe(0);
  });
});
