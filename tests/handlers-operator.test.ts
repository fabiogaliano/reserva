import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleCustomerCancel, handleCustomerReschedule, handleManage, handleOperatorCancel, handleOperatorNoShow, handleOperatorReschedule, handlePaymentWebhook } from '../src/handlers';
import type { RefundOperationRecord } from '../src/repo';
import { booking, config } from './fixtures';
import { fakeRefundTracker, fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');
const validNewStart = '2026-06-15T08:00:00.000Z';

function operatorRequest(path: string, body: Record<string, unknown>, bearer?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request(`https://example.test/api/booking/operator/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function rescheduleAsCustomer(token: string, newStart: string): Request {
  return new Request('https://example.test/api/booking/reschedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newStart }),
  });
}

function contextWithSecret(seed: ReturnType<typeof booking>[], overrides: Parameters<typeof providers>[0] = {}) {
  return createBookkitContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository(seed),
    clock,
    secrets: async () => 'expected-secret',
    providers: providers(overrides),
  });
}

describe('operator route auth (spec §11 dual-auth resolver)', () => {
  it('rejects a wrong operator token with 403', async () => {
    const seeded = booking({ id: 'b-op-auth-wrong-token' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: 'not-the-token', refund: 'none' }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a missing operator token and missing bearer with 403', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository([booking({ id: 'b-op-auth-missing' })]), clock, providers: providers() });
    const response = await handleOperatorCancel(operatorRequest('cancel', { refund: 'none' }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a customer cancel token used as an operator token (disjoint column lookup)', async () => {
    const seeded = booking({ id: 'b-op-auth-customer-token' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.cancelToken, refund: 'none' }), context);
    expect(response.status).toBe(403);
  });

  it('accepts the bearer + bookingId path with the correct shared secret', async () => {
    const seeded = booking({ id: 'b-op-auth-bearer-ok' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { bookingId: seeded.id, refund: 'none' }, 'expected-secret'), context);
    expect(response.status).toBe(200);
  });

  it('rejects the bearer path with a wrong shared secret', async () => {
    const seeded = booking({ id: 'b-op-auth-bearer-wrong' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { bookingId: seeded.id, refund: 'none' }, 'wrong-secret'), context);
    expect(response.status).toBe(403);
  });

  it('returns 404 not_found for the bearer path with an unknown bookingId', async () => {
    const context = contextWithSecret([]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { bookingId: 'no-such-booking', refund: 'none' }, 'expected-secret'), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('POST /operator/cancel with refund (spec §11)', () => {
  it('refund: full on a confirmed row with a payment intent calls refund() exactly once, and a retried request is idempotent', async () => {
    const seeded = booking({ id: 'b-op-cancel-refund-full', paymentRef: 'pi_refund_full' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_full', amountMinor: seeded.priceMinor }; } } }),
    });

    const first = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(first.status).toBe(200);
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('operator');
    expect(refunds).toBe(1);

    // Redeliver the same request (simulating a retry): handleOperatorCancel's early
    // return on an already-cancelled row guarantees no second refund.
    const second = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(second.status).toBe(200);
    expect(refunds).toBe(1);
  });

  it('executes and records a goodwill refund requested after a customer cancellation', async () => {
    const seeded = booking({
      id: 'b-op-cancel-customer-goodwill',
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'customer',
      paymentRef: 'pi_customer_goodwill',
    });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => { throw new Error('unused'); },
        getSession: async () => ({ status: 'open' }),
        refund: async () => {
          refunds += 1;
          return { refundRef: 're_customer_goodwill', amountMinor: seeded.priceMinor };
        },
      } }),
    });

    const first = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(first.status).toBe(200);
    expect(refunds).toBe(1);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({
      choice: 'full', status: 'succeeded', stripeRefundId: 're_customer_goodwill', amountCents: seeded.priceMinor,
    });

    const second = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(second.status).toBe(200);
    expect(refunds).toBe(1);
  });

  it('rejects a goodwill refund without a payment intent without creating an operation', async () => {
    const seeded = booking({
      id: 'b-op-cancel-customer-no-payment-intent',
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'customer',
      paymentRef: null,
    });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => { throw new Error('unused'); },
        getSession: async () => ({ status: 'open' }),
        refund: async () => {
          refunds += 1;
          return { refundRef: 're_should_not_run', amountMinor: seeded.priceMinor };
        },
      } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'refund_payment_ref_missing' } });
    expect(refunds).toBe(0);
    expect(repo.refundOperations.has(seeded.id)).toBe(false);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });
  });

  it('rejects a full refund without a payment intent before claiming or cancelling, while none still cancels', async () => {
    const seeded = booking({ id: 'b-op-cancel-confirmed-no-payment-intent', paymentRef: null });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => {
        refunds += 1;
        return { refundRef: 're_should_not_run', amountMinor: seeded.priceMinor };
      } } }),
    });

    const full = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(full.status).toBe(409);
    await expect(full.json()).resolves.toMatchObject({ error: { code: 'refund_payment_ref_missing' } });
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
    expect(repo.refundOperations.has(seeded.id)).toBe(false);
    expect(refunds).toBe(0);

    const none = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(none.status).toBe(200);
    expect(none.headers.get('cache-control')).toBe('no-store');
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ choice: 'none', status: 'succeeded' });
    expect(refunds).toBe(0);
  });

  it('marks a legacy full-refund operation without a payment intent as failed instead of succeeded', async () => {
    const seeded = booking({
      id: 'b-op-cancel-legacy-no-payment-intent',
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'operator',
      paymentRef: null,
    });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({
      id: 'op-legacy-no-payment-intent', bookingId: seeded.id, paymentIntent: null, choice: 'full', requestedAt: '2026-06-14T07:00:00.000Z',
    });
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'refund_payment_ref_missing' } });
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'failed', error: 'payment reference is missing' });
  });

  it.each(['requested', 'failed'] as const)('allows an expired operator token to recover a %s refund only through cancellation', async (status) => {
    const seeded = booking({
      id: `b-expired-${status}-refund`,
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'operator',
      paymentRef: `pi_expired_${status}`,
    });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({
      id: `op-expired-${status}`, bookingId: seeded.id, paymentIntent: seeded.paymentRef,
      choice: 'full', requestedAt: '2026-06-14T07:00:00.000Z',
    });
    if (status === 'failed') {
      await repo.resolveRefundOperation(`op-expired-${status}`, {
        status: 'failed', error: 'temporary failure', resolvedAt: '2026-06-14T07:01:00.000Z',
      });
    }
    const tokenState = repo.tokenState.get(seeded.id);
    if (!tokenState) throw new Error('Seeded booking token state is missing');
    tokenState.tokensExpireAt = '2026-06-14T07:30:00.000Z';
    let refunds = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => { throw new Error('unused'); },
        getSession: async () => ({ status: 'open' }),
        refund: async () => { refunds += 1; return { refundRef: `re_${status}`, amountMinor: seeded.priceMinor }; },
      } }),
    });

    const manage = await handleManage(new Request(`https://example.test/api/booking/manage?token=${seeded.operatorToken}`), context);
    expect(manage.status).toBe(403);
    const reschedule = await handleOperatorReschedule(operatorRequest('reschedule', {
      operatorToken: seeded.operatorToken, newStart: validNewStart,
    }), context);
    expect(reschedule.status).toBe(403);
    const noShow = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(noShow.status).toBe(403);

    const recovery = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(recovery.status).toBe(200);
    expect(refunds).toBe(1);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded' });
  });

  // getBookingByOperatorTokenForRefundRecovery (src/repo.ts) only lets an expired token through
  // when a refund operation is still 'requested' or 'failed' — a resolved ('succeeded') operation,
  // or no operation row at all, must fall back to the plain expiry check and get the same generic
  // 403 an unknown token would.
  it('rejects an expired operator token on cancel once its refund operation has already succeeded', async () => {
    const seeded = booking({
      id: 'b-expired-refund-succeeded',
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'operator',
      paymentRef: 'pi_expired_succeeded',
    });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({
      id: 'op-expired-succeeded', bookingId: seeded.id, paymentIntent: seeded.paymentRef,
      choice: 'full', requestedAt: '2026-06-14T07:00:00.000Z',
    });
    await repo.resolveRefundOperation('op-expired-succeeded', {
      status: 'succeeded', stripeRefundId: 're_expired_succeeded', amountCents: seeded.priceMinor, resolvedAt: '2026-06-14T07:01:00.000Z',
    });
    const tokenState = repo.tokenState.get(seeded.id);
    if (!tokenState) throw new Error('Seeded booking token state is missing');
    tokenState.tokensExpireAt = '2026-06-14T07:30:00.000Z';
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBe(403);
  });

  it('rejects an expired operator token on cancel when there is no refund operation at all', async () => {
    const seeded = booking({
      id: 'b-expired-no-refund-op',
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'operator',
      paymentRef: 'pi_expired_no_op',
    });
    const repo = fakeRepository([seeded]);
    const tokenState = repo.tokenState.get(seeded.id);
    if (!tokenState) throw new Error('Seeded booking token state is missing');
    tokenState.tokensExpireAt = '2026-06-14T07:30:00.000Z';
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBe(403);
  });

  // Only handleOperatorCancel passes refundRecovery=true to operatorBooking (src/handlers/index.ts)
  // — handleManage, handleOperatorReschedule, and handleOperatorNoShow always use the plain
  // getBookingByOperatorToken lookup, so an expired token must stay 403 on those routes even while
  // an unresolved ('requested') refund operation exists that would let handleOperatorCancel through.
  it('confines the expired-token recovery bypass to the cancel route: manage, reschedule, and no-show stay 403 while a refund operation is still requested', async () => {
    const seeded = booking({
      id: 'b-expired-requested-route-scope',
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'operator',
      paymentRef: 'pi_expired_route_scope',
    });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({
      id: 'op-expired-route-scope', bookingId: seeded.id, paymentIntent: seeded.paymentRef,
      choice: 'full', requestedAt: '2026-06-14T07:00:00.000Z',
    });
    const tokenState = repo.tokenState.get(seeded.id);
    if (!tokenState) throw new Error('Seeded booking token state is missing');
    tokenState.tokensExpireAt = '2026-06-14T07:30:00.000Z';
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const manage = await handleManage(new Request(`https://example.test/api/booking/manage?token=${seeded.operatorToken}`), context);
    expect(manage.status).toBe(403);
    const reschedule = await handleOperatorReschedule(operatorRequest('reschedule', {
      operatorToken: seeded.operatorToken, newStart: validNewStart,
    }), context);
    expect(reschedule.status).toBe(403);
    const noShow = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(noShow.status).toBe(403);
  });

  it('refund: none cancels without ever calling refund()', async () => {
    const seeded = booking({ id: 'b-op-cancel-refund-none', paymentRef: 'pi_refund_none' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_none', amountMinor: seeded.priceMinor }; } } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(refunds).toBe(0);
  });

  it('rejects a missing/invalid refund field with 400 validation_failed', async () => {
    const seeded = booking({ id: 'b-op-cancel-missing-refund' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects a cancel on a non-confirmed row with 409 invalid_transition', async () => {
    const seeded = booking({ id: 'b-op-cancel-wrong-state', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
  });

  it('a throwing refund() surfaces as a non-2xx response, but the cancellation is already durable and the failure is recorded on the operation row (BK-REFUND-001)', async () => {
    const seeded = booking({ id: 'b-op-cancel-refund-throws', paymentRef: 'pi_refund_throws' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { throw new Error('refund provider down'); } } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    // The refund decision + cancellation are claimed and committed before Stripe is ever called
    // (durability requirement), so the booking is cancelled even though the refund call failed —
    // the failure lives on the operation row for retry/reconciliation instead of being lost.
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    const operation = repo.refundOperations.get(seeded.id);
    expect(operation?.status).toBe('failed');
    expect(operation?.error).toContain('refund provider down');
  });

  it('(F7) a refund=full and refund=none request racing FOR REAL on the same booking: exactly one cancels and refunds, the loser calls no Stripe and gets refund_conflict — including the already-cancelled interleaving that follows (BK-REFUND-001)', async () => {
    const seeded = booking({ id: 'b-op-cancel-race', paymentRef: 'pi_refund_race' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_race', amountMinor: seeded.priceMinor }; } } }),
    });

    // Two REAL handler invocations racing on the same booking via the same repo (not a
    // pre-seeded winner) — this exercises the actual claim/CAS interleaving between two
    // in-flight requests, matching how a real double-click or duplicate request would arrive.
    const [fullResponse, noneResponse] = await Promise.all([
      handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context),
      handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context),
    ]);

    const outcomes = [
      { choice: 'full' as const, response: fullResponse },
      { choice: 'none' as const, response: noneResponse },
    ];
    const winner = outcomes.find((outcome) => outcome.response.status === 200);
    const loser = outcomes.find((outcome) => outcome.response.status === 409);
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    await expect(loser!.response.json()).resolves.toMatchObject({ error: { code: 'refund_conflict' } });
    // Exactly one cancellation happened, and Stripe was only ever called if 'full' is the winner.
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    const expectedRefunds = winner!.choice === 'full' ? 1 : 0;
    expect(refunds).toBe(expectedRefunds);

    // Already-cancelled interleaving: a THIRD request replaying the LOSING choice must still be
    // rejected — it must never silently resume (or re-drive) the winner's decision just because
    // the booking is now cancelled.
    const replayLoser = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: loser!.choice }), context);
    expect(replayLoser.status).toBe(409);
    await expect(replayLoser.json()).resolves.toMatchObject({ error: { code: 'refund_conflict' } });
    expect(refunds).toBe(expectedRefunds); // no extra Stripe call from the replayed loser

    // Replaying the WINNING choice is the genuine-retry path: it resolves ok with no new Stripe
    // call, since that operation already succeeded.
    const replayWinner = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: winner!.choice }), context);
    expect(replayWinner.status).toBe(200);
    expect(refunds).toBe(expectedRefunds);
  });

  it('a crash between Stripe success and recording it recovers on retry and records the refund id (D1-failure-after-Stripe-success)', async () => {
    const seeded = booking({ id: 'b-op-cancel-crash-recovery', paymentRef: 'pi_refund_crash' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_crash_recovered', amountMinor: seeded.priceMinor }; } } }),
    });

    // Simulate a claim + CAS cancel that both landed, but the process crashed before Stripe was
    // ever called (or before the result was recorded) — the operation row is left 'requested'.
    await repo.claimRefundOperation({ id: 'op-crash-1', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full', requestedAt: '2026-06-14T08:00:00.000Z' });
    repo.rows.set(seeded.id, { ...seeded, status: 'cancelled', cancelledAt: '2026-06-14T08:00:00.000Z', cancelledBy: 'operator' });

    const retry = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(retry.status).toBe(200);
    expect(refunds).toBe(1);
    const operation = repo.refundOperations.get(seeded.id);
    expect(operation?.status).toBe('succeeded');
    expect(operation?.stripeRefundId).toBe('re_crash_recovered');
  });

  it('(F8) a crash after Stripe succeeds but before the D1 resolve write lands is never recorded as failed, and a retry recovers using the same idempotency key (finding #4)', async () => {
    const seeded = booking({ id: 'b-op-cancel-post-stripe-d1-crash', paymentRef: 'pi_post_stripe_crash' });
    const repo = fakeRepository([seeded]);
    const { refund, idempotencyKeys } = fakeRefundTracker(() => ({ refundRef: 're_post_stripe_crash', amountMinor: seeded.priceMinor }));
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund } }),
    });

    // Make the FIRST attempt to record a 'succeeded' outcome throw, simulating Stripe succeeding
    // and then the D1 write that would have recorded it failing (crash, timeout, whatever).
    const realResolve = repo.resolveRefundOperation;
    let succeededWriteAttempts = 0;
    repo.resolveRefundOperation = async (id, input) => {
      if (input.status === 'succeeded') {
        succeededWriteAttempts += 1;
        if (succeededWriteAttempts === 1) throw new Error('simulated D1 write failure');
      }
      return realResolve(id, input);
    };

    const first = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    // The cancellation itself already committed (CAS ran before Stripe was ever called), so only
    // the post-Stripe resolve write failed — the caller sees a plain error, not a false 'failed'.
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    // Finding #4: a Stripe-success-then-D1-write-failure must never be recorded as a Stripe
    // failure — the row stays 'requested', never 'failed'.
    expect(repo.refundOperations.get(seeded.id)?.status).toBe('requested');
    expect(idempotencyKeys).toHaveLength(1);

    const retry = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(retry.status).toBe(200);
    const operation = repo.refundOperations.get(seeded.id);
    expect(operation?.status).toBe('succeeded');
    expect(operation?.stripeRefundId).toBe('re_post_stripe_crash');
    // Recovery reused the SAME idempotency key rather than minting a fresh one per attempt.
    expect(idempotencyKeys).toEqual(['bookkit-refund-pi_post_stripe_crash', 'bookkit-refund-pi_post_stripe_crash']);
  });

  // BK-REFUND-001 (audit requirement 5): the handler must forward the booking's full expected
  // price as the second argument to payments.refund() so the provider can reject partial-amount
  // reconciliations. Without this, a stale or unrelated historical Stripe refund with a different
  // amount could satisfy reconciliation even though the customer still owes money.
  it('passes the booking\'s priceMinor as the expectedAmountCents argument to payments.refund()', async () => {
    const seeded = booking({ id: 'b-op-cancel-expected-amount', paymentRef: 'pi_expected_amount' });
    const repo = fakeRepository([seeded]);
    const { refund, expectedAmounts } = fakeRefundTracker(() => ({ refundRef: 're_expected_amount', amountMinor: seeded.priceMinor }));
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBe(200);
    // The provider must receive the booking's full price, not zero, undefined, or an arbitrary value.
    expect(expectedAmounts).toEqual([seeded.priceMinor]);
  });

  it('(F9) a completely fresh repo instance resumes a requested same-choice operation from durable state', async () => {
    const seeded = booking({ id: 'b-op-cancel-fresh-repo-pending', paymentRef: 'pi_fresh_repo_pending' }); // still confirmed
    const pendingOperation: RefundOperationRecord = {
      id: 'op-fresh-repo-pending', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full',
      status: 'requested', stripeRefundId: null, amountCents: null, requestedAt: '2026-06-14T07:00:00.000Z', resolvedAt: null, error: null,
      executionClaimToken: null, executionClaimUntil: null, attemptCount: 0, attemptedAt: null,
      failureStartedAt: null, nextAttemptAt: null,
    };
    // A brand-new repo instance — no object here is shared with whatever originally produced
    // this state — seeded to look exactly like a fresh D1 read from a different isolate would: a
    // same-choice claim already exists, but the booking is still confirmed because the original
    // claim-holder crashed before its CAS.
    const freshRepo = fakeRepository([seeded]);
    freshRepo.refundOperations.set(seeded.id, pendingOperation);
    let refunds = 0;
    const freshContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: freshRepo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_should_not_happen', amountMinor: seeded.priceMinor }; } } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), freshContext);
    expect(response.status).toBe(200);
    expect(refunds).toBe(1);
    expect(freshRepo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(freshRepo.refundOperations.get(seeded.id)?.status).toBe('succeeded');

    const retry = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), freshContext);
    expect(retry.status).toBe(200);
    expect(refunds).toBe(1);
  });

  it('resumes a requested same-choice claim when its first cancellation attempt crashes before the CAS', async () => {
    const seeded = booking({ id: 'b-op-cancel-resume-requested', paymentRef: 'pi_resume_requested' });
    const repo = fakeRepository([seeded]);
    const realTransition = repo.transitionToCancelled;
    let transitionAttempts = 0;
    repo.transitionToCancelled = async (id, input) => {
      transitionAttempts += 1;
      if (transitionAttempts === 1) throw new Error('simulated worker crash');
      return realTransition(id, input);
    };
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => {
        refunds += 1;
        return { refundRef: 're_resume_requested', amountMinor: seeded.priceMinor };
      } } }),
    });

    const crashed = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(crashed.status).toBeGreaterThanOrEqual(500);
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ choice: 'full', status: 'requested' });

    const conflict = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'refund_conflict' } });

    const retry = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(retry.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded', stripeRefundId: 're_resume_requested' });
    expect(refunds).toBe(1);
  });

  it('a lost cancel CAS (e.g. a concurrent reschedule wins) does not leave a permanently-blocking operation row, and never calls Stripe on that lost attempt (finding #3)', async () => {
    const seeded = booking({ id: 'b-op-cancel-lost-cas', paymentRef: 'pi_lost_cas' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    // Simulate a concurrent reschedule winning the race: the CAS cancel attempt finds starts_at
    // has already moved (exercised directly rather than via true concurrency — the real
    // uniqueness/CAS primitives are exercised against D1 in tests/workers/).
    const realTransition = repo.transitionToCancelled;
    repo.transitionToCancelled = async (id, input) => {
      const current = repo.rows.get(id);
      if (current) repo.rows.set(id, { ...current, startsAt: '2026-06-20T08:00:00.000Z' });
      return realTransition(id, input);
    };
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_lost_cas', amountMinor: seeded.priceMinor }; } } }),
    });

    const lost = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(lost.status).toBe(409);
    await expect(lost.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
    expect(refunds).toBe(0);
    // The lost claim must not linger as a permanent UNIQUE(booking_id) row: a later legitimate
    // cancel (against the booking's now-current start time) can still claim and refund.
    expect(repo.refundOperations.has(seeded.id)).toBe(false);

    repo.transitionToCancelled = realTransition;
    const retry = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(retry.status).toBe(200);
    expect(refunds).toBe(1);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
  });

  it('a lost operator cancel CAS to a customer cancellation resumes the claimed full refund instead of deleting it', async () => {
    const seeded = booking({ id: 'b-op-cancel-lost-cas-customer', paymentRef: 'pi_lost_cas_customer' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_lost_cas_customer', amountMinor: seeded.priceMinor }; } } }),
    });
    const realTransition = repo.transitionToCancelled;
    repo.transitionToCancelled = async (id, input) => {
      if (input.cancelledBy === 'operator') {
        const customer = await handleCustomerCancel(new Request('https://example.test/api/booking/cancel', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: seeded.cancelToken }),
        }), context);
        expect(customer.status).toBe(200);
      }
      return realTransition(id, input);
    };

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(refunds).toBe(1);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded', stripeRefundId: 're_lost_cas_customer' });
  });

  it('a charge.refunded webhook that wins the operator cancel CAS preserves its succeeded operation row', async () => {
    const paymentRef = 'pi_lost_cas_webhook';
    const seeded = booking({ id: 'b-op-cancel-lost-cas-webhook', paymentRef: paymentRef });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => ({ id: 'evt_lost_cas_webhook', type: 'refunded', paymentRef, amountCaptured: seeded.priceMinor, amountRefunded: seeded.priceMinor, refundRef: 're_webhook_won' }), getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_should_not_run', amountMinor: seeded.priceMinor }; } } }),
    });
    const realTransition = repo.transitionToCancelled;
    repo.transitionToCancelled = async (id, input) => {
      if (input.expectedStartsAt !== undefined) {
        const webhook = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
        expect(webhook.status).toBe(200);
      }
      return realTransition(id, input);
    };

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBe(200);
    expect(refunds).toBe(0);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded', stripeRefundId: 're_webhook_won', amountCents: seeded.priceMinor });
  });

  // BK-REFUND-001: Stripe is the source of truth for whether money moved — a charge.refunded
  // webhook arriving after an operator recorded refund='none' (e.g. a dashboard-initiated refund
  // Bookkit didn't drive) must correct that row rather than leave it stating no refund happened.
  it('an authoritative charge.refunded webhook corrects an earlier none/succeeded refund row on an already-cancelled booking, and a follow-up operator refund=full request is idempotent', async () => {
    const paymentRef = 'pi_webhook_corrects_none';
    const seeded = booking({ id: 'b-webhook-corrects-none', paymentRef: paymentRef });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_webhook_corrects_none', type: 'refunded', paymentRef,
            amountCaptured: seeded.priceMinor, amountRefunded: seeded.priceMinor, refundRef: 're_webhook_corrects_none',
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => { refunds += 1; return { refundRef: 're_should_not_run', amountMinor: seeded.priceMinor }; },
        },
      }),
    });

    const initialCancel = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(initialCancel.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ choice: 'none', status: 'succeeded' });

    const webhook = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(webhook.status).toBe(200);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({
      choice: 'full', status: 'succeeded', stripeRefundId: 're_webhook_corrects_none', amountCents: seeded.priceMinor,
    });

    // The correction must not reopen the door to a second Stripe call: the booking is already
    // cancelled and the (now-corrected) operation row already says 'full'/'succeeded'.
    const followUp = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(followUp.status).toBe(200);
    await expect(followUp.json()).resolves.toEqual({ ok: true });
    expect(refunds).toBe(0);
  });

  // src/handlers/index.ts:507-508 — a partial refund (amountRefunded < amountCaptured) never
  // cancels the booking or touches the refund-operation row; it only logs. This pins that guard
  // against silently overwriting an existing (unrelated) operation record too.
  it('a partial-refund webhook does not rewrite an existing refund operation row or cancel the booking', async () => {
    const paymentRef = 'pi_partial_refund_guard';
    const seeded = booking({ id: 'b-partial-refund-guard', status: 'confirmed', paymentRef: paymentRef });
    const repo = fakeRepository([seeded]);
    repo.refundOperations.set(seeded.id, {
      id: 'op-preexisting', bookingId: seeded.id, paymentIntent: paymentRef, choice: 'none', status: 'succeeded',
      stripeRefundId: null, amountCents: null, requestedAt: '2026-06-13T00:00:00.000Z', resolvedAt: '2026-06-13T00:00:00.000Z', error: null,
      executionClaimToken: null, executionClaimUntil: null, attemptCount: 0, attemptedAt: null,
      failureStartedAt: null, nextAttemptAt: null,
    });
    const preexisting = repo.refundOperations.get(seeded.id);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_partial_refund_guard', type: 'refunded', paymentRef,
            amountCaptured: seeded.priceMinor, amountRefunded: Math.floor(seeded.priceMinor / 2),
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_should_not_run', amountMinor: seeded.priceMinor }),
        },
      }),
    });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
    expect(repo.refundOperations.get(seeded.id)).toEqual(preexisting);
  });

  it('a same-choice loser re-reads the operation after the winner records success, ending in one consistent succeeded refund', async () => {
    const seeded = booking({ id: 'b-op-cancel-same-choice-resolve-race', paymentRef: 'pi_same_choice_resolve_race' });
    const repo = fakeRepository([seeded]);
    let notifyLoserReached: (() => void) | undefined;
    const loserReached = new Promise<void>((resolve) => { notifyLoserReached = resolve; });
    let notifyWinnerResolved: (() => void) | undefined;
    const winnerResolved = new Promise<void>((resolve) => { notifyWinnerResolved = resolve; });
    const realGetBookingById = repo.getBookingById;
    repo.getBookingById = async (id) => {
      notifyLoserReached?.();
      await winnerResolved;
      return realGetBookingById(id);
    };
    // BK-SEC-002: getBookingByOperatorToken now hashes the presented token (a genuine async
    // WebCrypto op, unlike the old synchronous in-memory find()), so the two concurrent requests'
    // initial token lookups no longer reliably resolve in lockstep before either can progress.
    // The "loser" can now reach the claim race by EITHER of two valid, already-existing paths
    // (src/handlers/index.ts handleOperatorCancel): losing claimRefundOperation (the `!claimed`
    // branch, which calls getBookingById), or observing status 'cancelled' directly because its
    // own lookup happened to resolve after the winner had already finished (the
    // reconcileCancelledRefund branch, which does not call getBookingById at all). Both branches'
    // very first repo call is getRefundOperationByBookingId, so triggering the same
    // notifyLoserReached from there too makes this test's synchronization robust to whichever
    // branch the loser actually takes, instead of assuming the specific one.
    const realGetRefundOperation = repo.getRefundOperationByBookingId;
    repo.getRefundOperationByBookingId = async (bookingId) => {
      notifyLoserReached?.();
      return realGetRefundOperation(bookingId);
    };
    const realTransition = repo.transitionToCancelled;
    repo.transitionToCancelled = async (id, input) => {
      const updated = await realTransition(id, input);
      await loserReached;
      return updated;
    };
    const realResolve = repo.resolveRefundOperation;
    repo.resolveRefundOperation = async (id, input) => {
      await realResolve(id, input);
      if (input.status === 'succeeded') notifyWinnerResolved?.();
    };
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      // BK-SEC-002 (continued from the comment above): with the loser now reachable via either
      // branch, a genuine race can put both the winner's own resolvePendingRefund call and the
      // loser's re-check within a hair of each other, so this mock can no longer assume it is
      // called at most once — it now models Stripe's real idempotency-key behavior instead (same
      // paymentRef -> the same refund result every time, never a second real charge), which is
      // the actual safety net resolvePendingRefund's own comment (src/handlers/index.ts) already
      // documents production relying on. What must still hold — and is asserted below — is that
      // the durable operation row ends up 'succeeded' with one consistent refund id.
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => {
        refunds += 1;
        return { refundRef: 're_same_choice', amountMinor: seeded.priceMinor };
      } } }),
    });

    const [first, second] = await Promise.all([
      handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context),
      handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refunds).toBeGreaterThanOrEqual(1);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded', stripeRefundId: 're_same_choice' });
  });

  it('a cross-context retry (fresh context, no shared memory) does not duplicate the Stripe call, because it relies on the durable operation row instead of refundedPayments', async () => {
    const seeded = booking({ id: 'b-op-cancel-cross-context', paymentRef: 'pi_refund_cross_context' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const paymentsOverride = { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 're_cross_context', amountMinor: seeded.priceMinor }; } };

    // Two independently-constructed contexts sharing only the same repo/db — the point of the
    // durable operation row: no in-memory Set survives across isolates, but the D1 row does.
    const contextA = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers({ payments: paymentsOverride }) });
    const contextB = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers({ payments: paymentsOverride }) });

    const first = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), contextA);
    expect(first.status).toBe(200);
    expect(refunds).toBe(1);

    const second = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), contextB);
    expect(second.status).toBe(200);
    expect(refunds).toBe(1);
  });
});

describe('POST /operator/reschedule cutoff asymmetry (spec §11)', () => {
  it('a booking starting inside the customer cutoff is 403 for customer reschedule but 200 for operator reschedule', async () => {
    const seeded = booking({ id: 'b-op-reschedule-cutoff', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z', calendarEventId: 'cal-op-reschedule' });
    const repo = fakeRepository([seeded]);
    let patches = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => { patches += 1; }, deleteEvent: async () => undefined } }),
    });

    const customerAttempt = await handleCustomerReschedule(rescheduleAsCustomer(seeded.cancelToken, validNewStart), context);
    expect(customerAttempt.status).toBe(403);
    await expect(customerAttempt.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(seeded.startsAt);

    const response = await handleOperatorReschedule(operatorRequest('reschedule', { operatorToken: seeded.operatorToken, newStart: validNewStart }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const row = repo.rows.get(seeded.id);
    expect(row?.startsAt).toBe(validNewStart);
    expect(row?.serviceSlug).toBe(seeded.serviceSlug);
    expect(row?.quantity).toBe(seeded.quantity);
    expect(row?.priceMinor).toBe(seeded.priceMinor);
    expect(patches).toBe(1);
  });
});

describe('POST /operator/no-show (spec §11)', () => {
  it('rejects marking no-show before the start with 409 invalid_transition', async () => {
    const seeded = booking({ id: 'b-op-noshow-before-start', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
  });

  it('rejects marking no-show on a hold row with 409', async () => {
    const seeded = booking({ id: 'b-op-noshow-hold', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T07:30:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(409);
  });

  it('rejects marking no-show on a cancelled row with 409', async () => {
    const seeded = booking({ id: 'b-op-noshow-cancelled', status: 'cancelled', cancelledAt: '2026-06-13T08:00:00.000Z', cancelledBy: 'customer', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T07:30:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(409);
  });

  it('marks a confirmed, past-start booking as no_show, dispatches booking.no_show, and repeating the call is idempotent', async () => {
    const seeded = booking({ id: 'b-op-noshow-valid', status: 'confirmed', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T07:30:00.000Z' });
    const repo = fakeRepository([seeded]);
    const emails: string[] = [];
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ email: { send: async (event) => { emails.push(event); } } }),
    });

    const first = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(repo.rows.get(seeded.id)?.status).toBe('no_show');
    expect(emails).toEqual(['booking.no_show']);

    const second = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(second.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('no_show');
    expect(emails).toEqual(['booking.no_show']);
  });
});
