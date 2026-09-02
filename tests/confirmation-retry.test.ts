import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { retrySideEffectOperation } from '../src/confirmation';
import type { SideEffectOperationIdentity, SideEffectOperationRecord } from '../src/repo';
import { booking, config } from './fixtures';
import { fakeRepository, providers, seedSideEffectOperation, sideEffectOperation, type FakeRepository } from './fakes';

const clock = () => new Date('2026-08-14T10:00:00.000Z');

function seedSideEffect(repo: FakeRepository, bookingId: string, identity: SideEffectOperationIdentity, patch: Partial<{
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'abandoned';
  attemptCount: number;
}>): SideEffectOperationRecord {
  return seedSideEffectOperation(repo, bookingId, identity, {
    status: patch.status ?? 'failed', attemptCount: patch.attemptCount ?? 10,
    attemptedAt: '2026-08-14T09:00:00.000Z', error: 'provider down',
    createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z',
    failureStartedAt: '2026-08-14T08:30:00.000Z',
  });
}

// The admin "Try again" action's underlying dispatcher, exercised directly (the admin handler
// itself is wired in the HTTP layer) — proving each kind bucket's claim -> run -> resolve/dispatch
// path and the STOP-condition-driven 'not_retryable' outcome for 'oversell'.
describe('retrySideEffectOperation', () => {
  it('refuses to retry an oversell marker (STOP condition: no safe one-shot retry for a permanent marker)', async () => {
    const seeded = booking({ id: 'retry-oversell', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    const operation = seedSideEffect(repo, seeded.id, { family: 'oversell' }, { status: 'succeeded' });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('not_retryable');
  });

  it('retries an abandoned calendar_create row past the attempt cap and succeeds', async () => {
    const seeded = booking({ id: 'retry-calendar-success', status: 'confirmed', calendarEventId: null });
    const repo = fakeRepository([seeded]);
    const operation = seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, { status: 'abandoned', attemptCount: 10 });
    let calendarCalls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { calendarCalls += 1; return 'cal_retry'; }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('succeeded');
    expect(calendarCalls).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'succeeded', attemptCount: 11 });
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBe('cal_retry');
  });

  it('retries an abandoned calendar_create row and records another failure when the provider is still down', async () => {
    const seeded = booking({ id: 'retry-calendar-fail', status: 'confirmed', calendarEventId: null });
    const repo = fakeRepository([seeded]);
    const operation = seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, { status: 'abandoned', attemptCount: 10 });
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { throw new Error('calendar still down'); }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('failed');
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })?.error).toContain('calendar still down');
  });

  it('reports lease_unavailable when a confirmation drain is already in progress for this booking', async () => {
    const seeded = booking({ id: 'retry-lease-busy', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    const operation = seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, { status: 'failed' });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });
    await repo.acquireConfirmationLease(seeded.id, 'someone-elses-token', clock().toISOString(), new Date(clock().getTime() + 5 * 60_000).toISOString());

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('lease_unavailable');
  });

  it('reports nothing_to_retry when the row has already succeeded', async () => {
    const seeded = booking({ id: 'retry-already-succeeded', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    const operation = seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, { status: 'succeeded' });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('nothing_to_retry');
  });

  it('retries an abandoned mutation-kind row (calendar_delete) and succeeds', async () => {
    const seeded = booking({ id: 'retry-mutation-success', status: 'cancelled', calendarEventId: 'cal_1' });
    const repo = fakeRepository([seeded]);
    const operation = seedSideEffect(repo, seeded.id, { family: 'calendar_delete' }, { status: 'abandoned', attemptCount: 10 });
    let deletes = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => 'cal_x', deleteEvent: async () => { deletes += 1; }, patchEvent: async () => undefined } }),
    });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('succeeded');
    expect(deletes).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_delete' })?.status).toBe('succeeded');
  });

  it('reports not_retryable and clears the claim when a mutation kind\'s provider is no longer configured', async () => {
    const seeded = booking({ id: 'retry-mutation-no-provider', status: 'cancelled', calendarEventId: 'cal_1' });
    const repo = fakeRepository([seeded]);
    const operation = seedSideEffect(repo, seeded.id, { family: 'calendar_delete' }, { status: 'abandoned', attemptCount: 10 });
    const { calendar: _unused, ...noCalendar } = providers();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: noCalendar });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('not_retryable');
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_delete' })).toMatchObject({ status: 'failed', error: 'Provider not configured' });
  });

  it('retries an abandoned durable hook row and succeeds', async () => {
    const seeded = booking({ id: 'retry-hook-success', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    const identity = { family: 'hook' as const, name: 'ops', event: 'booking.confirmed' };
    const operation = seedSideEffect(repo, seeded.id, identity, { status: 'abandoned', attemptCount: 10 });
    let deliveries = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock, providers: providers(),
      hooks: [{ name: 'ops', durable: true, handler: async () => { deliveries += 1; } }],
    });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('succeeded');
    expect(deliveries).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'succeeded', attemptCount: 11 });
  });

  // An unregistered subscriber is a PERMANENT failure, so even the
  // admin's bypass-everything retry re-abandons the row instead of leaving it forever pending.
  it('re-abandons a durable hook row whose subscriber is no longer registered', async () => {
    const seeded = booking({ id: 'retry-hook-unregistered', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    const identity = { family: 'hook' as const, name: 'ops', event: 'booking.confirmed' };
    const operation = seedSideEffect(repo, seeded.id, identity, { status: 'abandoned', attemptCount: 10 });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    await expect(retrySideEffectOperation(context, seeded, operation)).resolves.toBe('failed');
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'abandoned' });
    expect(sideEffectOperation(repo, seeded.id, identity)?.error).toContain('register a durable booking-event hook named "ops"');
  });
});
