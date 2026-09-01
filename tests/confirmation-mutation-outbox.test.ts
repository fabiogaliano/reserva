import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import type { ReservaProviders } from '../src/context';
import type { BookingEventHook, EmailBookingEvent, EmailProvider, EmailRecipientRole } from '../src/core/events';
import { createReservaContext } from '../src/context';
import { handleCustomerReschedule, handleOperatorNoShow } from '../src/handlers';
import { sideEffectOperationKey, type SideEffectOperationIdentity, type SideEffectOperationSeed } from '../src/repo';
import { booking, config } from './fixtures';
import { fakeRepository, providers, sideEffectOperation } from './fakes';

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

function providersWithoutEmail(overrides: Omit<Partial<ReservaProviders>, 'email'> = {}): ReservaProviders {
  const configured = providers(overrides);
  delete configured.email;
  return configured;
}

// A durable hook is the plan-021 replacement for v1's ops sink: its delivery debt is an outbox row
// claimed, retried, and abandoned exactly like an email row's.
function durableHook(name: string, handler: BookingEventHook['handler']): BookingEventHook {
  return { name, durable: true, handler };
}

function seed(identity: SideEffectOperationIdentity, eventPayloadJson: string | null = null): SideEffectOperationSeed {
  return { ...identity, eventPayloadJson, eventIdPrefix: null };
}

describe('mutation side-effect outbox', () => {
  it('records cancel, no-show, and reschedule rows with their winning transitions before delivery', async () => {
    const cancelled = booking({ id: 'mutation-cancel' });
    const noShow = booking({ id: 'mutation-no-show' });
    const rescheduled = booking({ id: 'mutation-reschedule' });
    const repo = fakeRepository([cancelled, noShow, rescheduled]);
    const now = '2026-06-14T08:00:00.000Z';
    const cancelIdentity: SideEffectOperationIdentity = { family: 'email', event: 'booking.cancelled_by_customer' };
    const noShowIdentity: SideEffectOperationIdentity = { family: 'hook', name: 'ops', event: 'booking.no_show' };
    const rescheduleIdentity: SideEffectOperationIdentity = { family: 'email', name: 'customer', event: 'booking.rescheduled' };

    await repo.transitionToCancelled(cancelled.id, {
      expectedStatusIn: ['confirmed'], cancelledAt: now, cancelledBy: 'customer', updatedAt: now,
      mutationSideEffects: [seed(cancelIdentity)],
    });
    await repo.transitionToNoShow(noShow.id, {
      expectedStatusIn: ['confirmed'], updatedAt: now, mutationSideEffects: [seed(noShowIdentity)],
    });
    await repo.rescheduleWithCapacity(rescheduled.id, {
      expectedStatus: 'confirmed', expectedStartsAt: rescheduled.startsAt,
      startsAt: '2026-06-16T09:00:00.000Z', endsAt: '2026-06-16T10:00:00.000Z',
      rescheduledFrom: rescheduled.startsAt, updatedAt: now, now,
      occupancyUnits: 1, occupancyEndsAt: '2026-06-16T10:30:00.000Z', localDate: '2026-06-16', defaultCapacity: 4,
      mutationSideEffects: [seed(rescheduleIdentity)],
    });

    expect(repo.rows.get(cancelled.id)?.status).toBe('cancelled');
    expect(repo.rows.get(noShow.id)?.status).toBe('no_show');
    expect(repo.rows.get(rescheduled.id)?.startsAt).toBe('2026-06-16T09:00:00.000Z');
    expect(sideEffectOperation(repo, cancelled.id, cancelIdentity)).toMatchObject({ status: 'pending' });
    expect(sideEffectOperation(repo, noShow.id, noShowIdentity)).toMatchObject({ status: 'pending' });
    // The reschedule transition version is assigned inside the winning write, not by the caller.
    expect(sideEffectOperation(repo, rescheduled.id, { ...rescheduleIdentity, discriminator: '1' })).toMatchObject({ status: 'pending' });
  });

  it('retries a failed row on a later idempotent booking-touching request', async () => {
    const seeded = booking({ id: 'mutation-drain', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    let calls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary email failure');
      } } }),
    });

    await expect(handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context)).resolves.toMatchObject({ status: 200 });
    const identity: SideEffectOperationIdentity = { family: 'email', event: 'booking.no_show' };
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'failed', attemptCount: 1 });

    await expect(handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context)).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('claims once when two drains overlap, preventing a double send', async () => {
    const seeded = booking({ id: 'mutation-claim-cas' });
    const repo = fakeRepository([seeded]);
    const identity: SideEffectOperationIdentity = { family: 'email', event: 'booking.no_show' };
    await repo.recordMutationSideEffectOperations(seeded.id, [seed(identity)], '2026-06-14T08:00:00.000Z');
    let started = (): void => undefined;
    const startedSend = new Promise<void>((resolve) => { started = resolve; });
    let release = (): void => undefined;
    const releaseSend = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const context = createReservaContext({
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
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });

  it('creates and fires distinct durable rows for A→B→A→B reschedules under one clock instant', async () => {
    const seeded = booking({
      id: 'mutation-reschedule-collision', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z',
    });
    const repo = fakeRepository([seeded]);
    const sent: string[] = [];
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async (event) => { sent.push(event); } } }),
    });

    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T09:30:00.000Z'), context)).resolves.toMatchObject({ status: 200 });
    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T09:00:00.000Z'), context)).resolves.toMatchObject({ status: 200 });
    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T09:30:00.000Z'), context)).resolves.toMatchObject({ status: 200 });

    const operations = await repo.listSideEffectOperations(seeded.id);
    const reschedules = operations.filter((operation) => operation.family === 'email' && operation.event === 'booking.rescheduled');
    expect(sent).toEqual(['booking.rescheduled', 'booking.rescheduled', 'booking.rescheduled']);
    expect(reschedules).toHaveLength(3);
    expect(new Set(reschedules.map(sideEffectOperationKey)).size).toBe(3);
    expect(reschedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'succeeded', attemptCount: 1 }),
    ]));
  });

  it('persists a pending row when the winning transition runs without dispatch', async () => {
    const seeded = booking({ id: 'mutation-no-wait-until', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);

    await expect(repo.transitionToNoShow(seeded.id, {
      expectedStatusIn: ['confirmed'], updatedAt: '2026-06-14T08:00:00.000Z',
      mutationSideEffects: [seed({ family: 'email', event: 'booking.no_show' })],
    })).resolves.toMatchObject({ status: 'no_show' });

    expect(sideEffectOperation(repo, seeded.id, { family: 'email', event: 'booking.no_show' })).toMatchObject({
      status: 'pending', attemptCount: 0,
    });
  });

  it('uses one combined row when a provider exposes recipients without a recipient sender', async () => {
    const seeded = booking({ id: 'mutation-partial-email', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const sent: string[] = [];
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: {
        recipientsForEvent: () => ['customer', 'owner'],
        send: async (event) => { sent.push(event); },
      } }),
    });

    await expect(handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context)).resolves.toMatchObject({ status: 200 });
    expect(sent).toEqual(['booking.no_show']);
    expect([...repo.sideEffectOperations.values()].filter((row) => row.family === 'email')).toEqual([
      expect.objectContaining({ name: null, event: 'booking.no_show', status: 'succeeded' }),
    ]);
  });

  it('leaves an existing recipient row owed when the current provider cannot send to a recipient', async () => {
    const seeded = booking({ id: 'mutation-provider-change' });
    const repo = fakeRepository([seeded]);
    await repo.recordMutationSideEffectOperations(seeded.id, [seed({ family: 'email', name: 'customer', event: 'booking.no_show' })], '2026-06-14T08:00:00.000Z');
    let sends = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async () => { sends += 1; } } }),
    });

    await runOwedMutationSideEffects(context, seeded);
    expect(sends).toBe(0);
    expect(sideEffectOperation(repo, seeded.id, { family: 'email', name: 'customer', event: 'booking.no_show' })).toMatchObject({ status: 'pending', attemptCount: 0 });
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
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email }),
    });

    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    expect(email.recipients).toEqual(['customer']);
    expect(sideEffectOperation(repo, seeded.id, { family: 'email', name: 'customer', event: 'booking.no_show' })).toMatchObject({ status: 'succeeded' });
  });

  it('retries only a failed owner recipient row', async () => {
    const seeded = booking({ id: 'mutation-owner-retry', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const recipients: string[] = [];
    let ownerAttempts = 0;
    const context = createReservaContext({
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
    expect(sideEffectOperation(repo, seeded.id, { family: 'email', name: 'customer', event: 'booking.no_show' })).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(sideEffectOperation(repo, seeded.id, { family: 'email', name: 'owner', event: 'booking.no_show' })).toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('retries a failed durable hook delivery on a later booking request', async () => {
    const seeded = booking({ id: 'mutation-hook-retry', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    let calls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providersWithoutEmail(),
      hooks: [durableHook('ops', async () => {
        calls += 1;
        if (calls === 1) throw new Error('subscriber unavailable');
      })],
    });

    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    expect(calls).toBe(2);
    expect(sideEffectOperation(repo, seeded.id, { family: 'hook', name: 'ops', event: 'booking.no_show' }))
      .toMatchObject({ status: 'succeeded', attemptCount: 2 });
  });

  it('logs mutation provider failures without their response body', async () => {
    const seeded = booking({ id: 'mutation-log-body', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const warnings: Array<{ message: string; data: Record<string, unknown> | undefined }> = [];
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      logger: { warn: (message, data) => { warnings.push({ message, data }); } },
      providers: providersWithoutEmail(),
      hooks: [durableHook('ops', async () => {
        throw Object.assign(new Error('provider response: private payload'), { status: 503 });
      })],
    });

    await handleOperatorNoShow(operatorNoShowRequest(seeded.operatorToken), context);
    expect(warnings).toEqual([expect.objectContaining({
      message: 'reserva mutation side effect failed',
      data: expect.objectContaining({ provider: 'hook', status: 503 }),
    })]);
    expect(JSON.stringify(warnings)).not.toContain('private payload');
  });
});
