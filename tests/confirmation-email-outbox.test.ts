import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import { createReservaContext, type ReservaProviders } from '../src/context';
import { handleStatus, handlePaymentWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { sameSideEffectOperation, type SideEffectOperationIdentity } from '../src/repo';
import { fakeRepository, providers, seedSideEffectOperation, sideEffectOperation } from './fakes';

const CUSTOMER: SideEffectOperationIdentity = { family: 'email', name: 'customer', event: 'booking.confirmed' };
const OWNER: SideEffectOperationIdentity = { family: 'email', name: 'owner', event: 'booking.confirmed' };

function paidWebhookProviders(bookingId: string, sessionRef: string, overrides: Partial<ReservaProviders> = {}) {
  return providers({
    payments: {
      createCheckout: async () => ({ url: '', sessionRef: '' }),
      parseWebhook: async () => ({
        id: 'evt_email_outbox', type: 'checkout_completed', bookingId, sessionRef,
        paymentRef: 'pi_email_outbox', paid: true, amountCaptured: 10000, currency: config.business.currency,
      }),
      getSession: async () => ({ status: 'open' }),
      refund: async () => ({ refundRef: 're_email_outbox', amountMinor: 0 }),
    },
    ...overrides,
  });
}

// Per-recipient confirmation email operations. Complements confirmation-outbox.test.ts
// (which covers the plain-send/combined shape) with coverage for a split-capable provider's
// per-recipient email rows (family 'email', name 'customer'/'owner', event 'booking.confirmed').
describe('confirmation-path per-recipient email outbox', () => {
  it('sends only the owner recipient on retry after an owner-recipient failure, never resending the already-delivered customer message', async () => {
    const seeded = booking({ id: 'b-email-split-owner-fails', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_email_owner_fails' });
    const repo = fakeRepository([seeded]);
    const recipients: string[] = [];
    let ownerAttempts = 0;
    const context = createReservaContext({
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

    await expect(handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 500 });
    expect(recipients).toEqual(['customer', 'owner']);
    expect(sideEffectOperation(repo, seeded.id, CUSTOMER)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(sideEffectOperation(repo, seeded.id, OWNER)).toMatchObject({ status: 'failed', attemptCount: 1 });

    await expect(handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });
    // Only ONE more attempt happened (the owner retry) — the customer recipient is never sent again.
    expect(recipients).toEqual(['customer', 'owner', 'owner']);
    expect(recipients.filter((recipient) => recipient === 'customer')).toHaveLength(1);
    expect(sideEffectOperation(repo, seeded.id, OWNER)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  // The derived emailSynced flag this used to observe is gone; the per-recipient rows ARE
  // the record now, so the invariant is asserted where it lives — after the first recipient
  // resolves, the confirmation as a whole is still not delivered.
  it('counts the confirmation email as delivered only once BOTH split rows have succeeded, not after the first', async () => {
    const seeded = booking({ id: 'b-email-split-both-succeed', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_email_both_succeed' });
    const repo = fakeRepository([seeded]);
    const originalResolve = repo.resolveSideEffectOperation;
    const allEmailsDeliveredAfterResolve: Record<string, boolean> = {};
    repo.resolveSideEffectOperation = async (input) => {
      const result = await originalResolve(input);
      if (input.identity.family === 'email' && input.identity.name) {
        const emailRows = (await repo.listSideEffectOperations(input.bookingId))
          .filter((row) => row.family === 'email' && row.event === 'booking.confirmed');
        allEmailsDeliveredAfterResolve[input.identity.name] = emailRows.every((row) => row.status === 'succeeded');
      }
      return result;
    };
    const context = createReservaContext({
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

    await expect(handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });

    expect(allEmailsDeliveredAfterResolve.customer).toBe(false);
    expect(allEmailsDeliveredAfterResolve.owner).toBe(true);
  });

  it('a plain-send provider keeps the single combined email_confirmation row and existing behavior', async () => {
    const seeded = booking({ id: 'b-email-combined-unchanged', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_email_combined' });
    const repo = fakeRepository([seeded]);
    let sendCalls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_email_combined', {
        email: { send: async () => { sendCalls += 1; } },
      }),
    });

    await expect(handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });

    expect(sendCalls).toBe(1);
    const emailRows = (await repo.listSideEffectOperations(seeded.id)).filter((row) => row.family === 'email_confirmation' || row.family === 'email');
    expect(emailRows).toEqual([expect.objectContaining({ family: 'email_confirmation', status: 'succeeded' })]);
  });

  it('retries a seeded failed legacy combined row through send() and never creates split rows, even once the provider becomes split-capable', async () => {
    const seeded = booking({
      id: 'b-email-legacy-upgrade', status: 'confirmed', paymentSessionRef: 'cs_email_legacy_upgrade',
      calendarEventId: 'cal_email_legacy_upgrade',
    });
    const repo = fakeRepository([seeded]);
    const createdAt = '2026-06-14T08:00:00.000Z';
    seedSideEffectOperation(repo, seeded.id, { family: 'calendar_create' }, {
      status: 'succeeded', attemptCount: 1, attemptedAt: createdAt, resolvedAt: createdAt, createdAt, updatedAt: createdAt,
    });
    seedSideEffectOperation(repo, seeded.id, { family: 'email_confirmation' }, {
      status: 'failed', attemptCount: 1, attemptedAt: createdAt, resolvedAt: createdAt, error: 'legacy failure',
      createdAt, updatedAt: createdAt,
    });
    let sendCalls = 0;
    let sendToRecipientCalls = 0;
    const context = createReservaContext({
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
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'succeeded' });
    expect(sideEffectOperation(repo, seeded.id, CUSTOMER) !== undefined).toBe(false);
    expect(sideEffectOperation(repo, seeded.id, OWNER) !== undefined).toBe(false);
  });

  it('never lets the mutation drain claim a split confirmation email row', async () => {
    const seeded = booking({ id: 'b-email-split-mutation-drain-excluded' });
    const repo = fakeRepository([seeded]);
    const now = '2026-06-14T08:00:00.000Z';
    await repo.recordMutationSideEffectOperations(seeded.id, [CUSTOMER, OWNER].map((identity) => ({ ...identity, eventPayloadJson: null, eventIdPrefix: null })), now);
    let calls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock: () => new Date(now),
      providers: providers({ email: {
        recipientsForEvent: () => ['customer', 'owner'],
        sendToRecipient: async () => { calls += 1; },
        send: async () => undefined,
      } }),
    });

    await runOwedMutationSideEffects(context, seeded);

    expect(calls).toBe(0);
    expect(sideEffectOperation(repo, seeded.id, CUSTOMER)).toMatchObject({ status: 'pending', attemptCount: 0 });
    expect(sideEffectOperation(repo, seeded.id, OWNER)).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  it('a repository failure resolving the customer row does not block the independent owner row', async () => {
    const seeded = booking({ id: 'b-email-split-repo-write-fails', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_email_repo_write_fails' });
    const repo = fakeRepository([seeded]);
    const resolveOperation = repo.resolveSideEffectOperation;
    let failCustomerSuccessWrite = true;
    repo.resolveSideEffectOperation = async (input) => {
      if (sameSideEffectOperation(input.identity, CUSTOMER) && input.status === 'succeeded' && failCustomerSuccessWrite) {
        failCustomerSuccessWrite = false;
        throw new Error('D1 write failed after Brevo accepted the customer email');
      }
      return resolveOperation(input);
    };
    const recipients: string[] = [];
    const context = createReservaContext({
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

    await expect(handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 500 });
    expect(recipients).toEqual(['customer', 'owner']);
    expect(sideEffectOperation(repo, seeded.id, CUSTOMER)).toMatchObject({ status: 'failed', attemptCount: 1 });
    expect(sideEffectOperation(repo, seeded.id, OWNER)).toMatchObject({ status: 'succeeded', attemptCount: 1 });

    await expect(handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context)).resolves.toMatchObject({ status: 200 });
    expect(recipients).toEqual(['customer', 'owner', 'customer']);
    expect(sideEffectOperation(repo, seeded.id, CUSTOMER)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(sideEffectOperation(repo, seeded.id, OWNER)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });
});
