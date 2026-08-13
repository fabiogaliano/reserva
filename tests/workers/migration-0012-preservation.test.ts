// Plan 013 item D (audit finding #17): migrations/0012_calendar_delete_outbox.sql rebuilds
// side_effect_operations via rename -> create -> INSERT...SELECT * -> drop, the same rebuild shape
// 0010 and 0011 already have preservation tests for (tests/workers/repo-d1.test.ts:572,
// tests/workers/schema-constraints.test.ts:226). 0012 had none. This proves the actual migration,
// applied against real D1, carries every pre-existing outbox row through byte-for-byte, keeps the
// pending index, widens the kind CHECK to admit 'calendar_delete', and leaves no dangling FK.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestEnv {
  BOOKKIT_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.BOOKKIT_DB;

// Plan 017 (design decision 3): repo.insertHold now always writes meeting_point_id/-label
// (migration 0014), so it can't seed the FK-parent rows below against this test's deliberately
// pre-0012 schema. Only these FK-parent rows need to exist at all (nothing here asserts on their
// own columns) -- a raw INSERT covering just the columns 0001_init.sql guarantees NOT NULL,
// present since before every migration this suite ever slices before, decouples this
// historical-schema test from the CURRENT repo.ts column list going forward.
async function seedBooking(id: string): Promise<void> {
  await db.prepare(
    `INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at)
     VALUES (?, ?, 'vintage', 2, 'default', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'hold', ?, ?, '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z')`,
  ).bind(id, `BKT-2026-${id}`, `cancel-${id}`, `operator-${id}`).run();
}

describe('migration 0012 rebuild preserves every legacy outbox row (BK-SCHEMA-001)', () => {
  it('applies the actual 0012 migration while preserving every legacy outbox row, its index, and FK integrity', async () => {
    for (const table of [
      'side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults', 'day_overrides', 'bookings',
      'd1_migrations_0012_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0012_calendar_delete_outbox.sql');
    if (migrationIndex < 0) throw new Error('0012 migration missing from TEST_MIGRATIONS');
    const migration0012 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0012) throw new Error('0012 migration missing from TEST_MIGRATIONS');
    // Everything through 0011 -- a schema with none of 0012's widened kind constraint yet, matching
    // what a pre-upgrade production database looks like.
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0012_test');

    const legacyKinds = ['calendar_create', 'email_confirmation', 'oversell'];
    const statuses = ['pending', 'in_flight', 'succeeded', 'failed'];
    const seeded: Array<{ bookingId: string; kind: string; status: string; providerResultId: string | null; attemptCount: number; attemptedAt: string | null; resolvedAt: string | null; error: string | null; createdAt: string; updatedAt: string }> = [];
    for (const [kindIndex, kind] of legacyKinds.entries()) {
      for (const [statusIndex, status] of statuses.entries()) {
        const bookingId = `migration0012-${kindIndex}-${statusIndex}`;
        const stamp = `2026-07-21T10:0${kindIndex}${statusIndex}:00.000Z`;
        await seedBooking(bookingId);
        const row = {
          bookingId, kind, status,
          providerResultId: status === 'succeeded' ? `provider-${kindIndex}-${statusIndex}` : null,
          attemptCount: statusIndex,
          attemptedAt: status === 'pending' ? null : stamp,
          resolvedAt: status === 'succeeded' || status === 'failed' ? stamp : null,
          error: status === 'failed' ? `error-${kindIndex}-${statusIndex}` : null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        seeded.push(row);
        await db.prepare(
          `INSERT INTO side_effect_operations (
             booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.bookingId, row.kind, row.status, row.providerResultId, row.attemptCount, row.attemptedAt,
          row.resolvedAt, row.error, row.createdAt, row.updatedAt,
        ).run();
      }
    }

    // A pattern-based kind (email:%/tourflow:%, added in 0010) sitting in a genuinely stale in_flight
    // lease -- attempted_at long before "now" -- so the rebuild's byte-identity check also covers a
    // row shape the fixed-literal matrix above doesn't exercise.
    const staleLeaseRow = {
      bookingId: 'migration0012-stale-lease', kind: 'email:booking.confirmed', status: 'in_flight',
      providerResultId: null, attemptCount: 3, attemptedAt: '2026-07-21T06:00:00.000Z',
      resolvedAt: null, error: null, createdAt: '2026-07-21T05:00:00.000Z', updatedAt: '2026-07-21T06:00:00.000Z',
    };
    await seedBooking(staleLeaseRow.bookingId);
    await db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      staleLeaseRow.bookingId, staleLeaseRow.kind, staleLeaseRow.status, staleLeaseRow.providerResultId,
      staleLeaseRow.attemptCount, staleLeaseRow.attemptedAt, staleLeaseRow.resolvedAt, staleLeaseRow.error,
      staleLeaseRow.createdAt, staleLeaseRow.updatedAt,
    ).run();
    seeded.push(staleLeaseRow);

    await applyD1Migrations(db, [migration0012], 'd1_migrations_0012_test');

    const preserved = await db.prepare(
      `SELECT booking_id AS bookingId, kind, status, provider_result_id AS providerResultId, attempt_count AS attemptCount,
         attempted_at AS attemptedAt, resolved_at AS resolvedAt, error, created_at AS createdAt, updated_at AS updatedAt
       FROM side_effect_operations WHERE booking_id LIKE 'migration0012-%' ORDER BY booking_id, kind`,
    ).all<typeof seeded[number]>();
    expect(preserved.results).toEqual([...seeded].sort((a, b) => a.bookingId.localeCompare(b.bookingId) || a.kind.localeCompare(b.kind)));

    // The rebuild's whole point: 'calendar_delete' is now a legal kind, on the migrated (not
    // freshly created) table.
    await expect(db.prepare(
      `INSERT INTO side_effect_operations (booking_id, kind, status, attempt_count, created_at, updated_at)
       VALUES (?, 'calendar_delete', 'pending', 0, ?, ?)`,
    ).bind('migration0012-0-0', '2026-07-21T11:00:00.000Z', '2026-07-21T11:00:00.000Z').run()).resolves.toBeDefined();

    await expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_side_effect_operations_pending'`,
    ).all<{ name: string }>()).resolves.toMatchObject({ results: [{ name: 'idx_side_effect_operations_pending' }] });

    await expect(db.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] });
  });
});
