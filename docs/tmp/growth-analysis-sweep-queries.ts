// Lower bound on D1 queries one scheduled sweep issues, to compare with the Free plan's 50 queries
// per Worker invocation. Counts BookingRepository calls against the in-memory fake; every repo
// method issues at least one D1 statement, so real D1 counts are this number or higher.
// Run: bun --preload ./docs/tmp/perf/bun-virtual-config.ts docs/tmp/growth-analysis-sweep-queries.ts
import type { D1Database } from '@cloudflare/workers-types';
import { createReservaContext } from '../../src/context';
import { runReconciliationWithLease } from '../../src/reconciliation';
import type { BookingRepository } from '../../src/repo';
import { booking, config } from '../../tests/fixtures';
import { fakeRepository, providers, seedSideEffectOperation } from '../../tests/fakes';

async function measure(pending: number): Promise<{ calls: number; byMethod: Record<string, number> }> {
  const rows = Array.from({ length: pending }, (_, i) => booking({ id: `b-${i}`, reference: `R-${i}`, status: 'confirmed' }));
  const repo = fakeRepository(rows);
  for (const row of rows) {
    seedSideEffectOperation(repo, row.id, { family: 'calendar_create' }, { createdAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z' });
    seedSideEffectOperation(repo, row.id, { family: 'email_confirmation' }, { createdAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z' });
  }
  const byMethod: Record<string, number> = {};
  let calls = 0;
  const counted = new Proxy(repo, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls += 1;
        byMethod[String(key)] = (byMethod[String(key)] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as BookingRepository;
  const context = createReservaContext({
    config, db: {} as D1Database, repo: counted, clock: () => new Date('2026-08-14T10:00:00.000Z'),
    logger: {},
    providers: providers({
      calendar: { listEvents: async () => [], createEvent: async () => 'cal', deleteEvent: async () => undefined, patchEvent: async () => undefined },
    }),
  });
  await runReconciliationWithLease(context, { requireAlertSink: false });
  return { calls, byMethod };
}

for (const pending of [0, 1, 3, 5, 10, 20]) {
  const { calls, byMethod } = await measure(pending);
  console.log(`bookings with 2 owed side effects: ${pending} -> repo calls: ${calls}`);
  if (pending === 5) console.log(JSON.stringify(byMethod));
}

// The payment webhook's confirmation of one paid hold, with calendar + split customer/owner email.
import { confirmBookingFromPayment } from '../../src/confirmation';
{
  const hold = booking({ id: 'h-1', reference: 'R-H1', status: 'hold', holdExpiresAt: '2026-08-14T10:30:00.000Z', paymentSessionRef: 'cs_1' });
  const repo = fakeRepository([hold]);
  let calls = 0;
  const counted = new Proxy(repo, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { calls += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  }) as BookingRepository;
  const email = { send: async () => undefined, recipientsForEvent: () => ['customer', 'owner'] as const, sendToRecipient: async () => undefined };
  const context = createReservaContext({
    config, db: {} as D1Database, repo: counted, clock: () => new Date('2026-08-14T10:00:00.000Z'), logger: {},
    providers: providers({
      calendar: { listEvents: async () => [], createEvent: async () => 'cal', deleteEvent: async () => undefined, patchEvent: async () => undefined },
      email: email as never,
    }),
  });
  await confirmBookingFromPayment(context, hold, 'pi_1', { customerEmail: 'a@b.c', customerName: 'A' });
  console.log(`confirmation of one paid hold (calendar + customer/owner email) -> repo calls: ${calls}`);
}
