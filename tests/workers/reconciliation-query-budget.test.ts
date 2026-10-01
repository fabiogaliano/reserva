import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createReservaContext, withStoredSettings } from '../../src/context';
import { countD1Queries } from '../../src/d1-query-count';
import { runReconciliationWithLease } from '../../src/reconciliation';
import { checkReservaMigrationsApplied } from '../../src/schema-check';
import { config } from '../fixtures';
import { providers } from '../fakes';
import { seedHold } from './seed';

const db = (env as unknown as { RESERVA_DB: D1Database }).RESERVA_DB;
const FREE_PLAN_QUERIES_PER_INVOCATION = 50;

beforeEach(async () => {
  for (const table of ['operational_incidents', 'side_effect_operations', 'refund_operations', 'bookings']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function seedConfirmed(id: string, startsAt: string): Promise<void> {
  const context = createReservaContext({ config, db, providers: providers() });
  await seedHold(context.repo, {
    id, reference: `BKT-2026-${id}`, serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
    startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), locale: 'en',
    priceMinor: 12000, currency: 'eur', holdExpiresAt: '2026-07-21T10:35:00.000Z',
    cancelToken: `cancel-${id}`, operatorToken: `operator-${id}`,
    createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
  });
  await context.repo.transitionToConfirmed(id, { expectedStatusIn: ['hold'], paymentRef: `pi_${id}`, updatedAt: '2026-07-21T10:01:00.000Z' });
}

async function owe(bookingId: string, family: 'calendar_create' | 'email_confirmation', status: 'pending' | 'abandoned'): Promise<void> {
  await db.prepare(
    `INSERT INTO side_effect_operations (booking_id, family, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at, failure_started_at, next_attempt_at)
     VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', NULL, NULL)`,
  ).bind(bookingId, family, status, status === 'abandoned' ? 10 : 0).run();
}

async function count(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// The backlog an outage leaves behind, with every kind of step the sweep takes: confirmation rows
// to deliver, a refund whose cancellation never landed (its own outbox rows included), reminders
// coming due, and abandoned rows that must reach the operator as alerts.
async function seedBacklog(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await seedConfirmed(`owed-${index}`, '2026-08-20T09:00:00.000Z');
    await owe(`owed-${index}`, 'calendar_create', 'pending');
    await owe(`owed-${index}`, 'email_confirmation', 'pending');
  }
  await seedConfirmed('refund', '2026-08-20T09:00:00.000Z');
  await db.prepare("UPDATE bookings SET calendar_event_id = 'cal_refund' WHERE id = 'refund'").run();
  await createReservaContext({ config, db, providers: providers() }).repo.claimRefundOperation({
    id: 'op-refund', bookingId: 'refund', paymentIntent: 'pi_refund', choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z',
  });
  for (let index = 0; index < 3; index += 1) await seedConfirmed(`remind-${index}`, '2026-08-15T09:00:00.000Z');
  for (let index = 0; index < 2; index += 1) {
    await seedConfirmed(`abandoned-${index}`, '2026-08-20T09:00:00.000Z');
    await owe(`abandoned-${index}`, 'email_confirmation', 'abandoned');
  }
}

async function drained(alertsSent: number): Promise<boolean> {
  const [owedOpen, refundOpen, reminders, incidents] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM side_effect_operations WHERE booking_id LIKE 'owed-%' AND status != 'succeeded'"),
    count("SELECT COUNT(*) AS n FROM refund_operations WHERE status != 'succeeded'"),
    count("SELECT COUNT(*) AS n FROM side_effect_operations WHERE booking_id LIKE 'remind-%' AND status = 'succeeded'"),
    count("SELECT COUNT(*) AS n FROM operational_incidents WHERE status = 'open'"),
  ]);
  return owedOpen === 0 && refundOpen === 0 && reminders === 3 && incidents === 2 && alertsSent === 2;
}

describe('reconciliation query budget against real D1', () => {
  it('keeps every scheduled sweep of an outage backlog under the Free plan cap and finishes each step it starts', async () => {
    await seedBacklog();
    const schemaCheck = countD1Queries(db);
    await checkReservaMigrationsApplied(schemaCheck.db);

    let alertsSent = 0;
    let now = Date.parse('2026-08-14T10:00:00.000Z');
    let ticks = 0;
    while (!await drained(alertsSent)) {
      ticks += 1;
      expect(ticks, 'the backlog should drain over a bounded number of ticks').toBeLessThanOrEqual(20);
      // One cron invocation: a fresh context, the settings overlay, then the leased sweep.
      const tickAt = new Date(now);
      const base = createReservaContext({
        config, db, clock: () => tickAt, logger: {},
        providers: providers({ alerts: { send: async () => { alertsSent += 1; } } }),
      });
      const context = await withStoredSettings(base);
      await expect(runReconciliationWithLease(context)).resolves.toMatchObject({ kind: 'ran' });

      // A cold isolate also runs the schema check inside the same invocation.
      expect(schemaCheck.issued() + base.d1QueriesIssued!()).toBeLessThanOrEqual(FREE_PLAN_QUERIES_PER_INVOCATION);
      // Stopping between a claim and its resolve would leave the row in flight and re-run its
      // provider call next tick.
      expect(await count("SELECT COUNT(*) AS n FROM side_effect_operations WHERE status = 'in_flight'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_operations WHERE status = 'in_flight'")).toBe(0);
      now += 5 * 60_000;
    }
    expect(ticks).toBeGreaterThan(1);
  });

  it('sends a waiting operator alert from every sweep, whatever the budget, when a refund cancels a booking with a calendar event (the event delete\'s writeback went uncounted and ate the alert reserve)', async () => {
    for (let queryBudget = 6; queryBudget <= 40; queryBudget += 1) {
      for (const table of ['operational_incidents', 'side_effect_operations', 'refund_operations', 'bookings']) {
        await db.prepare(`DELETE FROM ${table}`).run();
      }
      await seedConfirmed('refund', '2026-08-20T09:00:00.000Z');
      await db.prepare("UPDATE bookings SET calendar_event_id = 'cal_refund' WHERE id = 'refund'").run();
      await createReservaContext({ config, db, providers: providers() }).repo.claimRefundOperation({
        id: 'op-refund', bookingId: 'refund', paymentIntent: 'pi_refund', choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z',
      });
      await seedConfirmed('abandoned', '2026-08-20T09:00:00.000Z');
      await owe('abandoned', 'email_confirmation', 'abandoned');
      await db.prepare(
        `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, attempt_count,
           first_detected_at, last_detected_at, source_updated_at, alert_revision, alerted_revision, alert_attempt_count)
         VALUES ('incident-abandoned', 'abandoned', 'side_effect', 'abandoned:email_confirmation', 'confirmation_email', 'open',
           'action_required', 10, '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', 1, 0, 0)`,
      ).run();
      const context = createReservaContext({
        config, db, clock: () => new Date('2026-08-14T10:00:00.000Z'), logger: {},
        providers: providers({ alerts: { send: async () => undefined } }),
      });

      await runReconciliationWithLease(context, { queryBudget });

      const alerted = await count("SELECT alerted_revision AS n FROM operational_incidents WHERE id = 'incident-abandoned'");
      expect(alerted, `query budget ${queryBudget}`).toBe(1);
    }
  });

  it('drains the same backlog in one sweep when given a Paid-plan budget', async () => {
    await seedBacklog();
    let alertsSent = 0;
    const context = createReservaContext({
      config, db, clock: () => new Date('2026-08-14T10:00:00.000Z'), logger: {},
      providers: providers({ alerts: { send: async () => { alertsSent += 1; } } }),
    });

    await runReconciliationWithLease(context, { queryBudget: 1000 });

    expect(await drained(alertsSent)).toBe(true);
  });
});
