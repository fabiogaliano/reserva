// THROWAWAY measurement (not for commit): D1 rows_read per idle-sweep statement against a
// realistically sized history of settled bookings.
import { env } from 'cloudflare:workers';
import { describe, it } from 'vitest';
import { createReservaContext, withStoredSettings } from '../../src/context';
import { runReconciliationWithLease } from '../../src/reconciliation';
import { config } from '../fixtures';
import { providers } from '../fakes';
import { seedHold } from './seed';

const db = (env as unknown as { RESERVA_DB: D1Database }).RESERVA_DB;

interface Sample { sql: string; rowsRead: number; rowsWritten: number }

function recording(target: D1Database, samples: Sample[]): D1Database {
  const label = (sql: string) => sql.replace(/\s+/g, ' ').slice(0, 90);
  const sqlOf = new WeakMap<object, string>();
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(t, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(t.bind(...values), sql);
        const value: unknown = Reflect.get(t, key, t);
        if (typeof value !== 'function') return value;
        if (key === 'all' || key === 'run') {
          return async (...args: unknown[]) => {
            const result = await value.apply(t, args) as D1Result;
            samples.push({ sql: label(sql), rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
            return result;
          };
        }
        if (key === 'first' || key === 'raw') {
          return async (...args: unknown[]) => {
            samples.push({ sql: `[${String(key)}, unmeasured] ${label(sql)}`, rowsRead: NaN, rowsWritten: NaN });
            return value.apply(t, args);
          };
        }
        return value.bind(t);
      },
    });
    sqlOf.set(proxy, sql);
    originals.set(proxy, statement);
    return proxy;
  };
  return new Proxy(target, {
    get(t, key) {
      if (key === 'prepare') return (sql: string) => wrap(t.prepare(sql), sql);
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await t.batch(statements.map((s) => originals.get(s) ?? s));
          results.forEach((result, index) => samples.push({
            sql: `[batch] ${label(sqlOf.get(statements[index]!) ?? '?')}`,
            rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written,
          }));
          return results;
        };
      }
      const value: unknown = Reflect.get(t, key, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}

async function seedHistory(bookings: number, manualIncidents: number): Promise<void> {
  for (const table of ['operational_incidents', 'side_effect_operations', 'refund_operations', 'bookings']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  const context = createReservaContext({ config, db, providers: providers() });
  await seedHold(context.repo, {
    id: 'template', reference: 'BKT-T', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
    startsAt: '2025-08-20T09:00:00.000Z', endsAt: '2025-08-20T10:00:00.000Z', locale: 'en',
    priceMinor: 12000, currency: 'eur', holdExpiresAt: '2025-07-21T10:35:00.000Z',
    cancelToken: 'cancel-t', operatorToken: 'operator-t',
    createdAt: '2025-07-21T10:00:00.000Z', updatedAt: '2025-07-21T10:00:00.000Z',
  });
  await context.repo.transitionToConfirmed('template', { expectedStatusIn: ['hold'], paymentRef: 'pi_t', updatedAt: '2025-07-21T10:01:00.000Z' });
  const columns = (await db.prepare('PRAGMA table_info(bookings)').all<{ name: string }>()).results.map((c) => c.name);
  const unique: Record<string, string> = {
    id: "'b' || i", reference: "'R' || i", payment_session_ref: "'ps' || i", payment_ref: "'pi' || i",
    cancel_token: "'ct' || i", operator_token: "'ot' || i", cancel_token_hash: "'cth' || i", operator_token_hash: "'oth' || i",
    status: "'confirmed'", hold_expires_at: 'NULL',
  };
  const select = columns.map((c) => unique[c] ?? `t.${c}`).join(', ');
  await db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO bookings (${columns.join(', ')}) SELECT ${select} FROM n, bookings t WHERE t.id = 'template'`,
  ).bind(bookings).run();
  // Four settled rows per booking (calendar, customer email, owner email, one webhook) plus a sent reminder.
  for (const [family, name, event] of [
    ['calendar_create', null, null], ['email', 'customer', 'booking.confirmed'], ['email', 'owner', 'booking.confirmed'],
    ['webhook', 'partner', 'booking.confirmed'], ['email', 'customer', 'booking.reminder'],
  ] as const) {
    await db.prepare(
      `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, status, attempt_count, attempted_at, resolved_at, created_at, updated_at)
       SELECT id, ?, ?, ?, CASE WHEN ? = 'booking.reminder' THEN starts_at END, 'succeeded', 1, created_at, created_at, created_at, created_at
       FROM bookings WHERE id != 'template'`,
    ).bind(family, name, event, event).run();
  }
  // Manually resolved side-effect incidents stay reprojection candidates forever.
  await db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, attempt_count,
       first_detected_at, last_detected_at, source_updated_at, alert_revision, alerted_revision, alert_attempt_count,
       resolved_at, resolution_kind, resolved_by)
     SELECT 'inc' || i, 'b' || i, 'side_effect', 'b' || i || ':calendar_create', 'calendar', 'resolved', 'action_required', 10,
       '2025-07-21T10:00:00.000Z', '2025-07-21T10:00:00.000Z', '2025-07-21T10:00:00.000Z', 1, 1, 1,
       '2025-07-22T10:00:00.000Z', 'manual', 'ops@example.com'
     FROM n`,
  ).bind(manualIncidents).run();
}

describe('MEASURE idle sweep rows_read', () => {
  for (const [bookings, manualIncidents] of [[2000, 0], [2000, 20], [8000, 20]] as const) {
    it(`idle sweep with ${bookings} settled bookings, ${manualIncidents} manually resolved incidents`, async () => {
      await seedHistory(bookings, manualIncidents);
      const samples: Sample[] = [];
      const recorded = recording(db, samples);
      const base = createReservaContext({
        config, db: recorded, clock: () => new Date('2026-08-14T10:00:00.000Z'), logger: {},
        providers: providers({ alerts: { send: async () => undefined } }),
      });
      const context = await withStoredSettings(base);
      await runReconciliationWithLease(context);
      const total = samples.reduce((sum, s) => sum + (Number.isNaN(s.rowsRead) ? 0 : s.rowsRead), 0);
      console.log(`\n=== ${bookings} bookings (${bookings * 5} outbox rows), ${manualIncidents} manual incidents: ${samples.length} statements, rows_read total ${total}`);
      for (const s of samples) console.log(`${String(s.rowsRead).padStart(8)} r ${String(s.rowsWritten).padStart(4)} w  ${s.sql}`);
    }, 120_000);
  }
});

describe('MEASURE plans', () => {
  it('explains the scanning queries', async () => {
    await seedHistory(2000, 20);
    const samples: Sample[] = [];
    const recorded = recording(db, samples);
    const repo = createReservaContext({ config, db: recorded, providers: providers() }).repo;
    await repo.countSideEffectDebtByFamily();
    await repo.listSideEffectExecutionCandidates('2026-08-14T10:00:00.000Z', '2026-08-14T09:55:00.000Z', 10);
    for (const s of samples) console.log(`${String(s.rowsRead).padStart(8)} r  ${s.sql}`);
    const plans: Array<[string, string, unknown[]]> = [
      ['reminders', `EXPLAIN QUERY PLAN SELECT id FROM bookings WHERE status = 'confirmed' AND starts_at > ? AND starts_at <= ?
         AND julianday(created_at) < julianday(starts_at) - (? / 24.0)
         AND NOT EXISTS (SELECT 1 FROM side_effect_operations o WHERE o.booking_id = bookings.id AND o.family = 'email' AND o.event = 'booking.reminder' AND o.discriminator = bookings.starts_at)
         ORDER BY starts_at LIMIT ?`, ['2026-08-14T10:00:00.000Z', '2026-08-15T10:00:00.000Z', 24, 10]],
      ['oversell', `EXPLAIN QUERY PLAN SELECT booking_id FROM side_effect_operations WHERE family = 'oversell' AND status = 'succeeded'
         AND NOT EXISTS (SELECT 1 FROM operational_incidents WHERE source_type = 'oversell' AND source_key = side_effect_operations.booking_id) ORDER BY updated_at LIMIT 10`, []],
      ['reprojection', `EXPLAIN QUERY PLAN SELECT id FROM operational_incidents
         WHERE (status = 'open' OR (status = 'resolved' AND resolution_kind = 'manual'))
           AND ((source_type = 'side_effect' AND EXISTS (SELECT 1 FROM side_effect_operations
               WHERE side_effect_operations.booking_id || ':' || side_effect_operations.family || COALESCE(':' || side_effect_operations.name, '') || COALESCE(':' || side_effect_operations.event, '') || COALESCE(':' || side_effect_operations.discriminator, '') = operational_incidents.source_key
                 AND side_effect_operations.updated_at != operational_incidents.source_updated_at))
             OR (source_type = 'refund' AND (NOT EXISTS (SELECT 1 FROM refund_operations WHERE booking_id = operational_incidents.source_key))))
         ORDER BY last_detected_at, id LIMIT 10`, []],
    ];
    for (const [name, sql, params] of plans) {
      const rows = (await db.prepare(sql).bind(...params).all<{ detail: string }>()).results;
      console.log(`--- ${name}\n${rows.map((r) => `  ${r.detail}`).join('\n')}`);
    }
  }, 120_000);
});

describe('MEASURE candidate fixes', () => {
  it('rows_read after rewrites', async () => {
    await seedHistory(2000, 20);
    await db.prepare(`CREATE INDEX IF NOT EXISTS zz_oversell ON side_effect_operations (updated_at) WHERE family = 'oversell'`).run();
    const queries: Array<[string, string, unknown[]]> = [
      ['reminders +status', `SELECT id FROM bookings WHERE +status = 'confirmed' AND starts_at > ? AND starts_at <= ?
         AND julianday(created_at) < julianday(starts_at) - (? / 24.0)
         AND NOT EXISTS (SELECT 1 FROM side_effect_operations o WHERE o.booking_id = bookings.id AND o.family = 'email' AND o.event = 'booking.reminder' AND o.discriminator = bookings.starts_at)
         ORDER BY starts_at LIMIT ?`, ['2026-08-14T10:00:00.000Z', '2026-08-15T10:00:00.000Z', 24, 10]],
      ['oversell partial index +status', `SELECT booking_id FROM side_effect_operations WHERE family = 'oversell' AND +status = 'succeeded'
         AND NOT EXISTS (SELECT 1 FROM operational_incidents WHERE source_type = 'oversell' AND source_key = side_effect_operations.booking_id) ORDER BY updated_at LIMIT 10`, []],
      ['oversell partial index', `SELECT booking_id FROM side_effect_operations WHERE family = 'oversell' AND status = 'succeeded'
         AND NOT EXISTS (SELECT 1 FROM operational_incidents WHERE source_type = 'oversell' AND source_key = side_effect_operations.booking_id) ORDER BY updated_at LIMIT 10`, []],
      ['reprojection by booking_id', `SELECT id FROM operational_incidents
         WHERE (status = 'open' OR (status = 'resolved' AND resolution_kind = 'manual'))
           AND ((source_type = 'side_effect' AND EXISTS (SELECT 1 FROM side_effect_operations
               WHERE side_effect_operations.booking_id = operational_incidents.booking_id
                 AND side_effect_operations.booking_id || ':' || side_effect_operations.family || COALESCE(':' || side_effect_operations.name, '') || COALESCE(':' || side_effect_operations.event, '') || COALESCE(':' || side_effect_operations.discriminator, '') = operational_incidents.source_key
                 AND side_effect_operations.updated_at != operational_incidents.source_updated_at))
             OR (source_type = 'refund' AND (NOT EXISTS (SELECT 1 FROM refund_operations WHERE booking_id = operational_incidents.source_key))))
         ORDER BY last_detected_at, id LIMIT 10`, []],
    ];
    for (const [name, sql, params] of queries) {
      const result = await db.prepare(sql).bind(...params).all();
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results.map((r) => r.detail).join(' | ');
      console.log(`FIX ${name}: rows_read ${result.meta.rows_read} :: ${plan}`);
    }
  }, 120_000);
});

describe('MEASURE ops health rewrite', () => {
  it('status != vs IN on the existing index, and partial-index write cost', async () => {
    await seedHistory(2000, 0);
    await db.prepare("UPDATE side_effect_operations SET status = 'pending' WHERE booking_id IN ('b1', 'b2', 'b3') AND family = 'calendar_create'").run();
    await db.prepare("UPDATE side_effect_operations SET status = 'abandoned' WHERE booking_id IN ('b4', 'b5') AND family = 'calendar_create'").run();
    const select = `SELECT family,
        SUM(CASE WHEN status = 'abandoned' THEN 0 ELSE 1 END) AS pending,
        SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
        MIN(CASE WHEN status = 'abandoned' THEN NULL ELSE created_at END) AS oldest_pending_at
      FROM side_effect_operations WHERE %WHERE% GROUP BY family ORDER BY family`;
    for (const [name, where] of [
      ['today  status != succeeded', "status != 'succeeded'"],
      ['rewrite status IN (...)', "status IN ('pending', 'in_flight', 'failed', 'abandoned')"],
    ] as const) {
      const sql = select.replace('%WHERE%', where);
      const result = await db.prepare(sql).all();
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map((r) => r.detail).join(' | ');
      console.log(`OPS ${name}: rows_read ${result.meta.rows_read}, result ${JSON.stringify(result.results)} :: ${plan}`);
    }

    const insert = (id: string) => db.prepare(
      `INSERT INTO side_effect_operations (booking_id, family, name, event, status, attempt_count, created_at, updated_at)
       VALUES (?, 'email', 'customer', 'booking.cancelled_by_customer', 'pending', 0, '2026-08-14T10:00:00.000Z', '2026-08-14T10:00:00.000Z')`,
    ).bind(id).run();
    const before = await insert('b10');
    await db.prepare(`CREATE INDEX IF NOT EXISTS zz_oversell ON side_effect_operations (updated_at) WHERE family = 'oversell'`).run();
    const after = await insert('b11');
    const settle = await db.prepare("UPDATE side_effect_operations SET status = 'succeeded' WHERE booking_id = 'b11' AND family = 'email' AND event = 'booking.cancelled_by_customer'").run();
    console.log(`WRITES insert email row: ${before.meta.rows_written} without oversell index, ${after.meta.rows_written} with it; status change ${settle.meta.rows_written}`);
  }, 120_000);
});

describe('MEASURE http confirmation', () => {
  it('queries for one payment confirmation', async () => {
    const { confirmBookingFromPayment } = await import('../../src/confirmation');
    const { countD1Queries } = await import('../../src/d1-query-count');
    await seedHistory(1, 0);
    const seedContext = createReservaContext({ config, db, providers: providers() });
    const hold = await seedHold(seedContext.repo, {
      id: 'h1', reference: 'BKT-H1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-09-20T09:00:00.000Z', endsAt: '2026-09-20T10:00:00.000Z', locale: 'en',
      priceMinor: 12000, currency: 'eur', holdExpiresAt: '2026-08-14T10:35:00.000Z',
      cancelToken: 'cancel-h1', operatorToken: 'operator-h1',
      createdAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z',
    });
    const counted = countD1Queries(db);
    const pending: Promise<unknown>[] = [];
    const context = createReservaContext({
      config, db: counted.db, clock: () => new Date('2026-08-14T10:05:00.000Z'), logger: {},
      providers: providers({
        email: {
          send: async () => undefined,
          recipientsForEvent: () => ['customer', 'owner'],
          sendToRecipient: async () => undefined,
        },
      }),
      hooks: [{ name: 'ops', durable: true, events: ['booking.confirmed'], handler: async () => undefined }],
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    } as never);
    await confirmBookingFromPayment(context, hold, 'pi_h1', {});
    const inline = counted.issued();
    await Promise.all(pending);
    console.log(`HTTP confirm: ${inline} queries inline, ${counted.issued()} including detached delivery`);
    const rows = await db.prepare("SELECT family, name, event, status FROM side_effect_operations WHERE booking_id = 'h1'").all();
    console.log(`HTTP rows ${JSON.stringify(rows.results)}`);

    const { handlePaymentWebhook } = await import('../../src/handlers/webhook');
    const hold2 = await seedHold(seedContext.repo, {
      id: 'h2', reference: 'BKT-H2', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-09-21T09:00:00.000Z', endsAt: '2026-09-21T10:00:00.000Z', locale: 'en',
      priceMinor: 10000, currency: 'eur', holdExpiresAt: '2026-08-14T10:35:00.000Z',
      cancelToken: 'cancel-h2', operatorToken: 'operator-h2',
      createdAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z',
    });
    await seedContext.repo.updateBooking(hold2.id, { paymentSessionRef: 'cs_1', updatedAt: '2026-08-14T10:00:00.000Z' });
    const pending2: Promise<unknown>[] = [];
    const base = createReservaContext({
      config, db, clock: () => new Date('2026-08-14T10:05:00.000Z'), logger: {},
      providers: providers({
        email: { send: async () => undefined, recipientsForEvent: () => ['customer', 'owner'], sendToRecipient: async () => undefined },
        calendar: undefined,
      }),
      hooks: [{ name: 'ops', durable: true, events: ['booking.confirmed'], handler: async () => undefined }],
      waitUntil: (p: Promise<unknown>) => { pending2.push(p); },
    } as never);
    const routed = await withStoredSettings(base);
    const response = await handlePaymentWebhook(new Request('https://x.test/webhook', { method: 'POST', body: '{}' }), routed);
    await Promise.all(pending2);
    const status = await db.prepare("SELECT status FROM bookings WHERE id = 'h2'").first<{ status: string }>();
    console.log(`HTTP webhook handler: ${response.status}, booking ${status?.status}, ${base.d1QueriesIssued!()} queries incl. settings read and detached delivery (cold isolate adds 12)`);
  }, 120_000);
});
