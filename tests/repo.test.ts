import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookingRepository, type AdminChangeAudit, type SettingsBatchOperation } from '../src/repo';

// Minimal fake D1Database: every method under test only calls prepare(sql).bind(...args) and
// batch(statements). Proves atomicity depends on one batch() call carrying every statement (the
// change AND its history row), not N sequential .run()s.
function fakeD1(): { db: D1Database; batchCalls: Array<Array<{ sql: string; args: unknown[] }>> } {
  const batchCalls: Array<Array<{ sql: string; args: unknown[] }>> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({ sql, args }),
    }),
    batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
      batchCalls.push(statements);
      return [];
    },
  } as unknown as D1Database;
  return { db, batchCalls };
}

const AUDIT: AdminChangeAudit = { actor: 'ops@example.test', changedAt: '2026-09-01T12:00:00.000Z' };
const HISTORY_SQL = 'INSERT INTO admin_change_history (domain, item_key, action, value, actor, changed_at) VALUES (?, ?, ?, ?, ?, ?)';

describe('createBookingRepository.applySettingsBatch (atomic section save; history)', () => {
  // D1's batch() runs in an implicit single transaction -- the all-or-nothing guarantee only
  // holds if every operation and its history row travel in ONE batch() call; sequential .run()s
  // could each commit independently and leave a mixed revision or a change with no history row.
  it('sends every operation AND its history row as one db.batch() call carrying all the prepared statements, not sequential per-key writes', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);
    const operations: SettingsBatchOperation[] = [
      { type: 'upsert', key: 'booking.minNoticeHours', value: '2' },
      { type: 'upsert', key: 'booking.maxHorizonDays', value: '90' },
      { type: 'delete', key: 'booking.holdMinutes' },
    ];

    await repo.applySettingsBatch(operations, AUDIT);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      { sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['booking.minNoticeHours', '2'] },
      { sql: HISTORY_SQL, args: ['setting', 'booking.minNoticeHours', 'upsert', '2', AUDIT.actor, AUDIT.changedAt] },
      { sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['booking.maxHorizonDays', '90'] },
      { sql: HISTORY_SQL, args: ['setting', 'booking.maxHorizonDays', 'upsert', '90', AUDIT.actor, AUDIT.changedAt] },
      { sql: 'DELETE FROM settings WHERE key = ?', args: ['booking.holdMinutes'] },
      { sql: HISTORY_SQL, args: ['setting', 'booking.holdMinutes', 'delete', null, AUDIT.actor, AUDIT.changedAt] },
    ]);
  });

  it('does not call batch() for an empty operations list (no change means no history row either)', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.applySettingsBatch([], AUDIT);

    expect(batchCalls).toHaveLength(0);
  });
});

describe('createBookingRepository single-key admin writes', () => {
  it('deleteSetting is exactly one db.batch() call carrying the delete and its history row', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.deleteSetting('legal.termsUrl', AUDIT);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      { sql: 'DELETE FROM settings WHERE key = ?', args: ['legal.termsUrl'] },
      { sql: HISTORY_SQL, args: ['setting', 'legal.termsUrl', 'delete', null, AUDIT.actor, AUDIT.changedAt] },
    ]);
  });

  it('upsertCapacityDefault is exactly one db.batch() call, serializing {capacity, reason} as the history value', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.upsertCapacityDefault('2026-09-01', 3, 'peak season', AUDIT);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      {
        sql: `INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES (?, ?, ?)
           ON CONFLICT(from_date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
        args: ['2026-09-01', 3, 'peak season'],
      },
      { sql: HISTORY_SQL, args: ['capacity_default', '2026-09-01', 'upsert', JSON.stringify({ capacity: 3, reason: 'peak season' }), AUDIT.actor, AUDIT.changedAt] },
    ]);
  });

  it('deleteCapacityDefault is exactly one db.batch() call carrying the delete and its history row', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.deleteCapacityDefault('2026-09-01', AUDIT);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      { sql: 'DELETE FROM capacity_defaults WHERE from_date = ?', args: ['2026-09-01'] },
      { sql: HISTORY_SQL, args: ['capacity_default', '2026-09-01', 'delete', null, AUDIT.actor, AUDIT.changedAt] },
    ]);
  });
});

describe('createBookingRepository plural day-override writes', () => {
  it('upsertDayOverrides is exactly one db.batch() call carrying one change statement AND one history row per date', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.upsertDayOverrides(['2026-09-01', '2026-09-02'], 0, 'closed for maintenance', AUDIT);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(4);
    const value = JSON.stringify({ capacity: 0, reason: 'closed for maintenance' });
    expect(batchCalls[0]).toEqual([
      {
        sql: `INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
        args: ['2026-09-01', 0, 'closed for maintenance'],
      },
      { sql: HISTORY_SQL, args: ['day_override', '2026-09-01', 'upsert', value, AUDIT.actor, AUDIT.changedAt] },
      {
        sql: `INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
        args: ['2026-09-02', 0, 'closed for maintenance'],
      },
      { sql: HISTORY_SQL, args: ['day_override', '2026-09-02', 'upsert', value, AUDIT.actor, AUDIT.changedAt] },
    ]);
  });

  it('deleteDayOverrides is exactly one db.batch() call carrying one delete AND one history row per date', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.deleteDayOverrides(['2026-09-01', '2026-09-02'], AUDIT);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      { sql: 'DELETE FROM day_overrides WHERE date = ?', args: ['2026-09-01'] },
      { sql: HISTORY_SQL, args: ['day_override', '2026-09-01', 'delete', null, AUDIT.actor, AUDIT.changedAt] },
      { sql: 'DELETE FROM day_overrides WHERE date = ?', args: ['2026-09-02'] },
      { sql: HISTORY_SQL, args: ['day_override', '2026-09-02', 'delete', null, AUDIT.actor, AUDIT.changedAt] },
    ]);
  });

  it('an empty dates array calls batch() zero times for both plural methods (no change, no history)', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.upsertDayOverrides([], 9, 'should never land', AUDIT);
    await repo.deleteDayOverrides([], AUDIT);

    expect(batchCalls).toHaveLength(0);
  });
});
