import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createReservaContext, withStoredSettings } from '../../src/context';
import { runReconciliationWithLease } from '../../src/reconciliation';
import { config } from '../fixtures';
import { providers } from '../fakes';
import { seedHold } from './seed';

// D1 bills, and on the Free plan caps at 5 million a day, the rows a query scans, not the queries
// it runs. These queries run on a timer whether or not anyone books, so a scan that grows with the
// booking history eventually spends the whole allowance, and every D1 query then fails until
// midnight UTC. Counted on workerd's D1, whose SQLite plans these queries the way production does.

const db = (env as unknown as { RESERVA_DB: D1Database }).RESERVA_DB;

// A year of a busy small operator: 2,000 settled bookings with five delivered outbox rows each,
// and incidents an operator closed by hand, which stay reprojection candidates for good.
const SETTLED_BOOKINGS = 2_000;
const MANUALLY_RESOLVED_INCIDENTS = 20;

beforeEach(async () => {
  for (const table of ['operational_incidents', 'side_effect_operations', 'refund_operations', 'bookings']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

interface RowsRead {
  db: D1Database;
  total(): number;
  // The statements that read the most, so a failure names the query to look at.
  heaviest(): string;
}

// Sums meta.rows_read over everything the repository runs. first() and raw() return no meta, so
// they fail loudly here rather than read rows this count would miss.
function recordRowsRead(target: D1Database): RowsRead {
  const reads: Array<{ sql: string; rows: number }> = [];
  const sqlOf = new WeakMap<object, string>();
  const originals = new WeakMap<object, D1PreparedStatement>();
  const record = (sql: string, result: D1Result) => { reads.push({ sql, rows: result.meta.rows_read }); };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(statementTarget, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(statementTarget.bind(...values), sql);
        if (key === 'all' || key === 'run') {
          return async () => {
            const result = await statementTarget[key]();
            record(sql, result);
            return result;
          };
        }
        if (key === 'first' || key === 'raw') throw new Error(`${key}() reports no rows_read: ${sql}`);
        const value: unknown = Reflect.get(statementTarget, key, statementTarget);
        return typeof value === 'function' ? value.bind(statementTarget) : value;
      },
    });
    sqlOf.set(wrapped, sql);
    originals.set(wrapped, statement);
    return wrapped;
  };
  const recorded = new Proxy(target, {
    get(dbTarget, key) {
      if (key === 'prepare') return (sql: string) => wrap(dbTarget.prepare(sql), sql);
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await dbTarget.batch(statements.map((statement) => originals.get(statement) ?? statement));
          results.forEach((result, index) => record(sqlOf.get(statements[index] ?? {}) ?? 'batch statement', result));
          return results;
        };
      }
      const value: unknown = Reflect.get(dbTarget, key, dbTarget);
      return typeof value === 'function' ? value.bind(dbTarget) : value;
    },
  });
  return {
    db: recorded,
    total: () => reads.reduce((sum, read) => sum + read.rows, 0),
    heaviest: () => [...reads].sort((left, right) => right.rows - left.rows).slice(0, 3)
      .map((read) => `${read.rows} rows: ${read.sql.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n'),
  };
}

// Copies one booking confirmed through the production path, so every generated row satisfies the
// real schema, then gives each settled booking the outbox rows a delivered confirmation and its
// reminder leave behind.
async function seedSettledHistory(): Promise<void> {
  const context = createReservaContext({ config, db, providers: providers() });
  await seedHold(context.repo, {
    id: 'template', reference: 'BKT-2025-TEMPLATE', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
    startsAt: '2025-08-20T09:00:00.000Z', endsAt: '2025-08-20T10:00:00.000Z', locale: 'en',
    priceMinor: 12000, currency: 'eur', holdExpiresAt: '2025-07-21T10:35:00.000Z',
    cancelToken: 'cancel-template', operatorToken: 'operator-template',
    createdAt: '2025-07-21T10:00:00.000Z', updatedAt: '2025-07-21T10:00:00.000Z',
  });
  await context.repo.transitionToConfirmed('template', { expectedStatusIn: ['hold'], paymentRef: 'pi_template', updatedAt: '2025-07-21T10:01:00.000Z' });
  const columns = (await db.prepare('PRAGMA table_info(bookings)').all<{ name: string }>()).results.map((column) => column.name);
  const perBooking: Record<string, string> = {
    id: "'settled-' || n", reference: "'BKT-2025-' || n", payment_session_ref: "'cs_' || n", payment_ref: "'pi_' || n",
    cancel_token: "'cancel-' || n", operator_token: "'operator-' || n",
    cancel_token_hash: "'cancel-hash-' || n", operator_token_hash: "'operator-hash-' || n",
  };
  await db.prepare(
    `WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ?)
     INSERT INTO bookings (${columns.join(', ')})
     SELECT ${columns.map((column) => perBooking[column] ?? `template.${column}`).join(', ')}
     FROM counter, bookings AS template WHERE template.id = 'template'`,
  ).bind(SETTLED_BOOKINGS).run();
  await db.prepare("DELETE FROM bookings WHERE id = 'template'").run();
  const delivered = [
    ['calendar_create', null, null], ['email', 'customer', 'booking.confirmed'], ['email', 'owner', 'booking.confirmed'],
    ['webhook', 'partner', 'booking.confirmed'], ['email', 'customer', 'booking.reminder'],
  ] as const;
  for (const [family, name, event] of delivered) {
    await db.prepare(
      `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, status, attempt_count, attempted_at, resolved_at, created_at, updated_at)
       SELECT id, ?, ?, ?, CASE WHEN ? = 'booking.reminder' THEN starts_at END, 'succeeded', 1, created_at, created_at, created_at, created_at
       FROM bookings`,
    ).bind(family, name, event, event).run();
  }
  await db.prepare(
    `WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ?)
     INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, attempt_count,
       first_detected_at, last_detected_at, source_updated_at, alert_revision, alerted_revision, alert_attempt_count,
       resolved_at, resolution_kind, resolved_by)
     SELECT 'incident-' || n, 'settled-' || n, 'side_effect', 'settled-' || n || ':calendar_create', 'calendar', 'resolved', 'action_required', 10,
       '2025-07-21T10:05:00.000Z', '2025-07-21T10:05:00.000Z', '2025-07-21T10:00:00.000Z', 1, 1, 1,
       '2025-07-22T10:00:00.000Z', 'manual', 'ops@example.test'
     FROM counter`,
  ).bind(MANUALLY_RESOLVED_INCIDENTS).run();
}

describe('rows read by the timed and polled queries against real D1', () => {
  it('keeps an idle sweep to a bounded read however long the booking history (it used to read the whole outbox once per closed incident)', async () => {
    await seedSettledHistory();
    const rowsRead = recordRowsRead(db);
    const context = await withStoredSettings(createReservaContext({
      config, db: rowsRead.db, clock: () => new Date('2026-08-14T10:00:00.000Z'), logger: {},
      providers: providers({ alerts: { send: async () => undefined } }),
    }));

    await expect(runReconciliationWithLease(context)).resolves.toMatchObject({ kind: 'ran' });

    // 288 sweeps a day; at 1,000 rows each the idle sweep stays under 6% of the Free allowance
    // whatever the history. This history reads about 160; before the fix it read about 212,000.
    expect(rowsRead.total(), rowsRead.heaviest()).toBeLessThan(1_000);
  });

  it('counts outstanding delivery debt for ops health without reading settled rows (it used to read the whole outbox on every poll)', async () => {
    await seedSettledHistory();
    await db.prepare("UPDATE side_effect_operations SET status = 'failed' WHERE booking_id IN ('settled-1', 'settled-2') AND family = 'calendar_create'").run();
    await db.prepare("UPDATE side_effect_operations SET status = 'abandoned' WHERE booking_id = 'settled-3' AND family = 'calendar_create'").run();
    const rowsRead = recordRowsRead(db);

    const debt = await createReservaContext({ config, db: rowsRead.db, providers: providers() }).repo.countSideEffectDebtByFamily();

    expect(debt).toEqual([{ family: 'calendar_create', pending: 2, abandoned: 1, oldestPendingAt: '2025-07-21T10:00:00.000Z' }]);
    expect(rowsRead.total(), rowsRead.heaviest()).toBeLessThan(100);
  });
});
