import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookingRepository, type SettingsBatchOperation } from '../src/repo';

// Minimal fake D1Database: applySettingsBatch only ever calls prepare(sql).bind(...args) and
// batch(statements), so that's all this needs to fake. A real-D1 test (tests/workers/) would be
// preferable but can't force a genuine mid-batch failure yet: the `settings` table (migrations/
// 0005_settings.sql) has no CHECK/UNIQUE constraint to violate — those come in a later task. This
// unit test instead proves the mechanism atomicity depends on: one batch() call, not N .run()s.
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

describe('createBookingRepository.applySettingsBatch (BK-CONFIG-001 task 4: atomic section save)', () => {
  // D1's batch() runs its statements in an implicit single transaction — if any fails, none
  // commit. That all-or-nothing guarantee only holds if every operation travels in ONE batch()
  // call; sequential .run() calls would each commit independently and a mid-save failure could
  // leave a mixed revision. This proves applySettingsBatch actually does the former.
  it('sends every operation as one db.batch() call carrying all the prepared statements, not sequential per-key writes', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);
    const operations: SettingsBatchOperation[] = [
      { type: 'upsert', key: 'booking.minNoticeHours', value: '2' },
      { type: 'upsert', key: 'booking.maxHorizonDays', value: '90' },
      { type: 'delete', key: 'booking.holdMinutes' },
    ];

    await repo.applySettingsBatch(operations);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      { sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['booking.minNoticeHours', '2'] },
      { sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['booking.maxHorizonDays', '90'] },
      { sql: 'DELETE FROM settings WHERE key = ?', args: ['booking.holdMinutes'] },
    ]);
  });

  it('does not call batch() for an empty operations list', async () => {
    const { db, batchCalls } = fakeD1();
    const repo = createBookingRepository(db);

    await repo.applySettingsBatch([]);

    expect(batchCalls).toHaveLength(0);
  });
});
