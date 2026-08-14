import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import type { BookkitProviders } from '../src/context';
import type { EmailBookingEvent, EmailProvider, EmailRecipientRole } from '../src/core/events';
import { createBookkitContext } from '../src/context';
import { handleCustomerReschedule, handleOperatorNoShow } from '../src/handlers';
import type { SideEffectOperationKind } from '../src/repo';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');

function operatorNoShowRequest(operatorToken: string): Request {
  return new Request('https://example.test/api/operator/no-show', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operatorToken }),
  });
}

function rescheduleRequest(token: string, newStart: string): Request {
  return new Request('https://example.test/api/booking/reschedule', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, newStart }),
  });
}

function providersWithoutEmail(overrides: Omit<Partial<BookkitProviders>, 'email'>): BookkitProviders {
  const configured = providers(overrides);
  delete configured.email;
  return configured;
}

describe('mutation side-effect outbox', () => {
  it('records cancel, no-show, and reschedule rows with their winning transitions before delivery', async () => {
    const cancelled = booking({ id: 'mutation-cancel' });
    const noShow = booking({ id: 'mutation-no-show' });
    const rescheduled = booking({ id: 'mutation-reschedule' });
    const repo = fakeRepository([cancelled, noShow, rescheduled]);
    const now = '2026-06-14T08:00:00.000Z';
    const cancelKind: SideEffectOperationKind = 'email:booking.cancelled_by_customer';
    const noShowKind: SideEffectOperationKind = 'tourflow:booking.no_show';
    const rescheduleKind: SideEffectOperationKind = 'email:booking.rescheduled:customer:from-to';

    await repo.transitionToCancelled(cancelled.id, {
      expectedStatusIn: ['confirmed'], cancelledAt: now, cancelledBy: 'customer', updatedAt: now,
      mutationSideEffectKinds: [cancelKind],
    });
    await repo.transitionToNoShow(noShow.id, {
      expectedStatusIn: ['confirmed'], updatedAt: now, mutationSideEffectKinds: [noShowKind],
    });
    await repo.rescheduleWithCapacity(rescheduled.id, {
      expectedStatus: 'confirmed', expectedStartsAt: rescheduled.startsAt,
      startsAt: '2026-06-16T09:00:00.000Z', endsAt: '2026-06-16T10:00:00.000Z',
      rescheduledFrom: rescheduled.startsAt, updatedAt: now, now,
      occupancyUnits: 1, occupancyEndsAt: '2026-06-16T10:30:00.000Z', localDate: '2026-06-16', fleetDefaultCapacity: 4,
      mutationSideEffectKinds: [rescheduleKind],
    });

    expect(repo.rows.get(cancelled.id)?.status).toBe('cancelled');
    expect(repo.rows.get(noShow.id)?.status).toBe('no_show');
    expect(repo.rows.get(rescheduled.id)?.startsAt).toBe('2026-06-16T09:00:00.000Z');
    expect(repo.sideEffectOperations.get(`${cancelled.id}:${cancelKind}`)).toMatchObject({ status: 'pending' });
    expect(repo.sideEffectOperations.get(`${noShow.id}:${noShowKind}`)).toMatchObject({ status: 'pending' });
    expect(repo.sideEffectOperations.get(`${rescheduled.id}:${rescheduleKind}:1`)).toMatchObject({ status: 'pending' });
  });

  it('retries a failed row on a later idempotent booking-touching request', async () => {
    const seeded = booking({ id: 'mutation-drain', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    let calls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary email failure');
      } } }),
    });

    await expect(handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context)).resolves.toMatchObject({ status: 200 });
    const kind = 'email:booking.no_show';
    expect(repo.sideEffectOperations.get(`${seeded.id}:${kind}`)).toMatchObject({ status: 'failed', attemptCount: 1 });

    await expect(handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context)).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${kind}`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('claims once when two drains overlap, preventing a double send', async () => {
    const seeded = booking({ id: 'mutation-claim-cas' });
    const repo = fakeRepository([seeded]);
    const kind: SideEffectOperationKind = 'email:booking.no_show';
    await repo.recordMutationSideEffectOperations(seeded.id, [kind], '2026-06-14T08:00:00.000Z');
    let started = (): void => undefined;
    const startedSend = new Promise<void>((resolve) => { started = resolve; });
    let release = (): void => undefined;
    const releaseSend = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async () => {
        sends += 1;
        started();
        await releaseSend;
      } } }),
    });

    const first = runOwedMutationSideEffects(context, seeded);
    await startedSend;
    await runOwedMutationSideEffects(context, seeded);
    expect(sends).toBe(1);

    release();
    await first;
    expect(repo.sideEffectOperations.get(`${seeded.id}:${kind}`)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });

  it('creates and fires distinct durable rows for A→B→A→B reschedules under one clock instant', async () => {
    const seeded = booking({
      id: 'mutation-reschedule-collision', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z',
    });
    const repo = fakeRepository([seeded]);
    const sent: string[] = [];
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async (event) => { sent.push(event); } } }),
    });

    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T09:30:00.000Z'), context)).resolves.toMatchObject({ status: 200 });
    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T09:00:00.000Z'), context)).resolves.toMatchObject({ status: 200 });
    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T09:30:00.000Z'), context)).resolves.toMatchObject({ status: 200 });

    const operations = await repo.listSideEffectOperations(seeded.id);
    const reschedules = operations.filter((operation) => operation.kind.startsWith('email:booking.rescheduled:'));
    expect(sent).toEqual(['booking.rescheduled', 'booking.rescheduled', 'booking.rescheduled']);
    expect(reschedules).toHaveLength(3);
    expect(new Set(reschedules.map((operation) => operation.kind)).size).toBe(3);
    expect(reschedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'succeeded', attemptCount: 1 }),
    ]));
  });

  it('persists a pending row when the winning transition runs without dispatch', async () => {
    const seeded = booking({ id: 'mutation-no-wait-until', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);

    await expect(repo.transitionToNoShow(seeded.id, {
      expectedStatusIn: ['confirmed'], updatedAt: '2026-06-14T08:00:00.000Z',
      mutationSideEffectKinds: ['email:booking.no_show'],
    })).resolves.toMatchObject({ status: 'no_show' });

    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.no_show`)).toMatchObject({
      status: 'pending', attemptCount: 0,
    });
  });

  it('uses one combined row when a provider exposes recipients without a recipient sender', async () => {
    const seeded = booking({ id: 'mutation-partial-email', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const sent: string[] = [];
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: {
        recipientsForEvent: () => ['customer', 'owner'],
        send: async (event) => { sent.push(event); },
      } }),
    });

    await expect(handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context)).resolves.toMatchObject({ status: 200 });
    expect(sent).toEqual(['booking.no_show']);
    expect([...repo.sideEffectOperations.values()].filter((row) => row.kind.startsWith('email:'))).toEqual([
      expect.objectContaining({ kind: 'email:booking.no_show', status: 'succeeded' }),
    ]);
  });

  it('leaves an existing recipient row owed when the current provider cannot send to a recipient', async () => {
    const seeded = booking({ id: 'mutation-provider-change' });
    const repo = fakeRepository([seeded]);
    await repo.recordMutationSideEffectOperations(seeded.id, ['email:booking.no_show:customer'], '2026-06-14T08:00:00.000Z');
    let sends = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async () => { sends += 1; } } }),
    });

    await runOwedMutationSideEffects(context, seeded);
    expect(sends).toBe(0);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.no_show:customer`)).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  it('preserves a class-based provider method receiver for mutation recipient delivery', async () => {
    const seeded = booking({ id: 'mutation-email-method-receiver', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    class StatefulEmailProvider implements EmailProvider {
      readonly recipients: EmailRecipientRole[] = [];
      recipientsForEvent(): EmailRecipientRole[] { return ['customer']; }
      async send(): Promise<void> {}
      async sendToRecipient(recipient: EmailRecipientRole, _event: EmailBookingEvent): Promise<void> {
        this.recipients.push(recipient);
      }
    }
    const email = new StatefulEmailProvider();
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email }),
    });

    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    expect(email.recipients).toEqual(['customer']);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.no_show:customer`)).toMatchObject({ status: 'succeeded' });
  });

  it('retries only a failed owner recipient row', async () => {
    const seeded = booking({ id: 'mutation-owner-retry', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const recipients: string[] = [];
    let ownerAttempts = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: {
        recipientsForEvent: () => ['customer', 'owner'],
        sendToRecipient: async (recipient) => {
          recipients.push(recipient);
          if (recipient === 'owner' && ownerAttempts++ === 0) throw new Error('owner temporary failure');
        },
        send: async () => undefined,
      } }),
    });

    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    expect(recipients).toEqual(['customer', 'owner', 'owner']);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.no_show:customer`)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.no_show:owner`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('retries a failed Tourflow delivery on a later booking request', async () => {
    const seeded = booking({ id: 'mutation-tourflow-retry', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    let calls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providersWithoutEmail({ ops: { push: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Tourflow unavailable');
      } } }),
    });

    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    expect(calls).toBe(2);
    expect(repo.sideEffectOperations.get(`${seeded.id}:tourflow:booking.no_show`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('logs mutation provider failures without their response body', async () => {
    const seeded = booking({ id: 'mutation-log-body', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const warnings: Array<{ message: string; data: Record<string, unknown> | undefined }> = [];
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      logger: { warn: (message, data) => { warnings.push({ message, data }); } },
      providers: providersWithoutEmail({ ops: { push: async () => {
        throw Object.assign(new Error('provider response: private payload'), { status: 503 });
      } } }),
    });

    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    expect(warnings).toEqual([expect.objectContaining({
      message: 'bookkit mutation side effect failed',
      data: expect.objectContaining({ provider: 'tourflow', status: 503 }),
    })]);
    expect(JSON.stringify(warnings)).not.toContain('private payload');
  });
});
