import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import { createBookkitContext, type BookkitProviders } from '../src/context';
import { handleStatus, handleStripeWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const CUSTOMER_KIND = 'email:booking.confirmed:customer';
const OWNER_KIND = 'email:booking.confirmed:owner';

function paidWebhookProviders(bookingId: string, sessionId: string, overrides: Partial<BookkitProviders> = {}) {
  return providers({
    payments: {
      createCheckout: async () => ({ url: '', sessionId: '' }),
      parseWebhook: async () => ({
        id: 'evt_email_outbox', type: 'checkout.session.completed', bookingId, sessionId,
        paymentIntent: 'pi_email_outbox', paid: true, amountCaptured: 10000, currency: config.business.currency,
      }),
      getSession: async () => ({ status: 'open' }),
      refund: async () => ({ refundId: 're_email_outbox', amountCents: 0 }),
    },
    ...overrides,
  });
}

// Plan 012: per-recipient confirmation email operations. Complements confirmation-outbox.test.ts
// (which covers the plain-send/combined shape) with coverage for a split-capable provider's
// email:booking.confirmed:customer / email:booking.confirmed:owner rows.
describe('confirmation-path per-recipient email outbox (plan 012)', () => {
  it('sends only the owner recipient on retry after an owner-recipient failure, never resending the already-delivered customer message', async () => {
    const seeded = booking({ id: 'b-email-split-owner-fails', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_email_owner_fails' });
    const repo = fakeRepository([seeded]);
    const recipients: string[] = [];
    let ownerAttempts = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_email_owner_fails', {
        email: {
          recipientsForEvent: () => ['customer', 'owner'],
          sendToRecipient: async (recipient) => {
            recipients.push(recipient);
            if (recipient === 'owner' && ownerAttempts++ === 0) throw new Error('owner temporary failure');
          },
          send: async () => undefined,
        },
      }),
    });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 500 });
    expect(recipients).toEqual(['customer', 'owner']);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${CUSTOMER_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(repo.sideEffectOperations.get(`${seeded.id}:${OWNER_KIND}`)).toMatchObject({ status: 'failed', attemptCount: 1 });
    expect(repo.rows.get(seeded.id)).toMatchObject({ emailSynced: false });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });
    // Only ONE more attempt happened (the owner retry) — the customer recipient is never sent again.
    expect(recipients).toEqual(['customer', 'owner', 'owner']);
    expect(recipients.filter((recipient) => recipient === 'customer')).toHaveLength(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${OWNER_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(repo.rows.get(seeded.id)).toMatchObject({ emailSynced: true });
  });

  it('sets emailSynced true only once BOTH split rows have succeeded, not after the first', async () => {
    const seeded = booking({ id: 'b-email-split-both-succeed', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_email_both_succeed' });
    const repo = fakeRepository([seeded]);
    const originalResolve = repo.resolveSideEffectOperation;
    const emailSyncedAfterResolve: Record<string, boolean> = {};
    repo.resolveSideEffectOperation = async (input) => {
      const result = await originalResolve(input);
      if (input.kind === CUSTOMER_KIND || input.kind === OWNER_KIND) {
        emailSyncedAfterResolve[input.kind] = repo.rows.get(input.bookingId)?.emailSynced ?? false;
      }
      return result;
    };
    const context = createBookkitContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_email_both_succeed', {
        email: {
          recipientsForEvent: () => ['customer', 'owner'],
          sendToRecipient: async () => undefined,
          send: async () => undefined,
        },
      }),
    });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });

    expect(emailSyncedAfterResolve[CUSTOMER_KIND]).toBe(false);
    expect(emailSyncedAfterResolve[OWNER_KIND]).toBe(true);
    expect(repo.rows.get(seeded.id)).toMatchObject({ emailSynced: true });
  });

  it('a plain-send provider keeps the single combined email_confirmation row and existing behavior', async () => {
    const seeded = booking({ id: 'b-email-combined-unchanged', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_email_combined' });
    const repo = fakeRepository([seeded]);
    let sendCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_email_combined', {
        email: { send: async () => { sendCalls += 1; } },
      }),
    });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });

    expect(sendCalls).toBe(1);
    const emailRows = (await repo.listSideEffectOperations(seeded.id)).filter((row) => row.kind === 'email_confirmation' || row.kind.startsWith('email:booking.confirmed:'));
    expect(emailRows).toEqual([expect.objectContaining({ kind: 'email_confirmation', status: 'succeeded' })]);
    expect(repo.rows.get(seeded.id)).toMatchObject({ emailSynced: true });
  });

  it('retries a seeded failed legacy combined row through send() and never creates split rows, even once the provider becomes split-capable', async () => {
    const seeded = booking({
      id: 'b-email-legacy-upgrade', status: 'confirmed', stripeSessionId: 'cs_email_legacy_upgrade',
      calendarSynced: true, emailSynced: false, tourflowSynced: true,
    });
    const repo = fakeRepository([seeded]);
    const createdAt = '2026-06-14T08:00:00.000Z';
    repo.sideEffectOperations.set(`${seeded.id}:calendar_create`, {
      bookingId: seeded.id, kind: 'calendar_create', status: 'succeeded', providerResultId: null,
      attemptCount: 1, attemptedAt: createdAt, resolvedAt: createdAt, error: null, createdAt, updatedAt: createdAt,
    });
    repo.sideEffectOperations.set(`${seeded.id}:email_confirmation`, {
      bookingId: seeded.id, kind: 'email_confirmation', status: 'failed', providerResultId: null,
      attemptCount: 1, attemptedAt: createdAt, resolvedAt: createdAt, error: 'legacy failure', createdAt, updatedAt: createdAt,
    });
    let sendCalls = 0;
    let sendToRecipientCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        email: {
          recipientsForEvent: () => ['customer', 'owner'],
          sendToRecipient: async () => { sendToRecipientCalls += 1; },
          send: async () => { sendCalls += 1; },
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/status?session_id=cs_email_legacy_upgrade'), context);

    expect(response.status).toBe(200);
    expect(sendToRecipientCalls).toBe(0);
    expect(sendCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email_confirmation`)).toMatchObject({ status: 'succeeded' });
    expect(repo.sideEffectOperations.has(`${seeded.id}:${CUSTOMER_KIND}`)).toBe(false);
    expect(repo.sideEffectOperations.has(`${seeded.id}:${OWNER_KIND}`)).toBe(false);
    expect(repo.rows.get(seeded.id)).toMatchObject({ emailSynced: true });
  });

  it('never lets the mutation drain claim a split confirmation email row', async () => {
    const seeded = booking({ id: 'b-email-split-mutation-drain-excluded' });
    const repo = fakeRepository([seeded]);
    const now = '2026-06-14T08:00:00.000Z';
    await repo.recordMutationSideEffectOperations(seeded.id, [CUSTOMER_KIND, OWNER_KIND], now);
    let calls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date(now),
      providers: providers({ email: {
        recipientsForEvent: () => ['customer', 'owner'],
        sendToRecipient: async () => { calls += 1; },
        send: async () => undefined,
      } }),
    });

    await runOwedMutationSideEffects(context, seeded);

    expect(calls).toBe(0);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${CUSTOMER_KIND}`)).toMatchObject({ status: 'pending', attemptCount: 0 });
    expect(repo.sideEffectOperations.get(`${seeded.id}:${OWNER_KIND}`)).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  it('a repository failure resolving the customer row as succeeded leaves the owner row untouched, still pending', async () => {
    const seeded = booking({ id: 'b-email-split-repo-write-fails', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_email_repo_write_fails' });
    const repo = fakeRepository([seeded]);
    const resolveOperation = repo.resolveSideEffectOperation;
    let failCustomerSuccessWrite = true;
    repo.resolveSideEffectOperation = async (input) => {
      if (input.kind === CUSTOMER_KIND && input.status === 'succeeded' && failCustomerSuccessWrite) {
        failCustomerSuccessWrite = false;
        throw new Error('D1 write failed after Brevo accepted the customer email');
      }
      return resolveOperation(input);
    };
    const recipients: string[] = [];
    const context = createBookkitContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_email_repo_write_fails', {
        email: {
          recipientsForEvent: () => ['customer', 'owner'],
          sendToRecipient: async (recipient) => { recipients.push(recipient); },
          send: async () => undefined,
        },
      }),
    });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 500 });
    // The owner row was never reached — the customer row's D1 write failure stopped the loop
    // before the owner recipient was even attempted.
    expect(recipients).toEqual(['customer']);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${CUSTOMER_KIND}`)).toMatchObject({ status: 'failed', attemptCount: 1 });
    expect(repo.sideEffectOperations.get(`${seeded.id}:${OWNER_KIND}`)).toMatchObject({ status: 'pending', attemptCount: 0 });

    await expect(handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });
    expect(recipients).toEqual(['customer', 'customer', 'owner']);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${CUSTOMER_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(repo.sideEffectOperations.get(`${seeded.id}:${OWNER_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(repo.rows.get(seeded.id)).toMatchObject({ emailSynced: true });
  });
});
