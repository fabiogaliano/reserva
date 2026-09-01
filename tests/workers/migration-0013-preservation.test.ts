// Plan 016 (audit finding #12, scoped): migrations/0013_side_effect_operations_abandoned.sql
// rebuilds side_effect_operations the same way 0010/0011/0012 already do (rename -> create ->
// INSERT...SELECT -> drop — see tests/workers/migration-0012-preservation.test.ts, which this
// mirrors), plus a one-time upgrade conversion: any pre-existing nonterminal row already at or
// over the new attempt cap becomes 'abandoned' with a bounded max-attempts error, so no capped
// pending, failed, or stale in_flight row is left invisible to the claim predicates.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;

// Plan 017 (design decision 3): repo.insertHold now always writes meeting_point_id/-label
// (migration 0014), so it can't seed the FK-parent rows below against this test's deliberately
// pre-0013 schema. Only these FK-parent rows need to exist at all (nothing here asserts on their
// own columns) -- a raw INSERT covering just the columns 0001_init.sql guarantees NOT NULL,
// present since before every migration this suite ever slices before, decouples this
// historical-schema test from the CURRENT repo.ts column list going forward.
async function seedBooking(id: string): Promise<void> {
  await db.prepare(
    `INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at)
     VALUES (?, ?, 'vintage', 2, 'default', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'hold', ?, ?, '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z')`,
  ).bind(id, `BKT-2026-${id}`, `cancel-${id}`, `operator-${id}`).run();
}

async function insertRow(row: {
  bookingId: string; kind: string; status: string; providerResultId: string | null; attemptCount: number;
  attemptedAt: string | null; resolvedAt: string | null; error: string | null; createdAt: string; updatedAt: string;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO side_effect_operations (
       booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.bookingId, row.kind, row.status, row.providerResultId, row.attemptCount, row.attemptedAt,
    row.resolvedAt, row.error, row.createdAt, row.updatedAt,
  ).run();
}

describe('migration 0013 rebuild preserves every legacy outbox row and converts capped rows to abandoned', () => {
  it('applies the actual 0013 migration, preserving every ordinary row byte-for-byte, converting all nonterminal rows at/over the cap, and leaving index/FK/CHECK intact', async () => {
    for (const table of [
      'side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults', 'day_overrides', 'bookings',
      'd1_migrations_0013_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0013_side_effect_operations_abandoned.sql');
    if (migrationIndex < 0) throw new Error('0013 migration missing from TEST_MIGRATIONS');
    const migration0013 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0013) throw new Error('0013 migration missing from TEST_MIGRATIONS');
    // Everything through 0012 -- a schema with none of 0013's 'abandoned' status yet, matching what
    // a pre-upgrade production database looks like.
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0013_test');

    // Ordinary rows across every pre-existing status, none at the cap -- byte-identity preserved.
    const legacyKinds = ['calendar_create', 'email_confirmation', 'oversell', 'calendar_delete'];
    const statuses = ['pending', 'in_flight', 'succeeded', 'failed'];
    const preservedRows: Array<{ bookingId: string; kind: string; status: string; providerResultId: string | null; attemptCount: number; attemptedAt: string | null; resolvedAt: string | null; error: string | null; createdAt: string; updatedAt: string }> = [];
    for (const [kindIndex, kind] of legacyKinds.entries()) {
      for (const [statusIndex, status] of statuses.entries()) {
        const bookingId = `migration0013-ok-${kindIndex}-${statusIndex}`;
        const stamp = `2026-07-21T10:0${kindIndex}${statusIndex}:00.000Z`;
        await seedBooking(bookingId);
        const row = {
          bookingId, kind, status,
          providerResultId: status === 'succeeded' ? `provider-${kindIndex}-${statusIndex}` : null,
          attemptCount: statusIndex, // 0-3, always under the cap
          attemptedAt: status === 'pending' ? null : stamp,
          resolvedAt: status === 'succeeded' || status === 'failed' ? stamp : null,
          error: status === 'failed' ? `error-${kindIndex}-${statusIndex}` : null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        preservedRows.push(row);
        await insertRow(row);
      }
    }

    // The upgrade-conversion case (design decision 3): a 'pending' and a 'failed' row already at
    // the cap must become 'abandoned', gaining resolved_at (COALESCE'd from any existing resolved_at
    // or updated_at) and a bounded max-attempts error, while attempt_count/created_at/attempted_at
    // are left untouched.
    const cappedPending = {
      bookingId: 'migration0013-capped-pending', kind: 'email:booking.confirmed', status: 'pending',
      providerResultId: null, attemptCount: 10, attemptedAt: '2026-07-21T09:00:00.000Z',
      resolvedAt: null, error: null, createdAt: '2026-07-21T05:00:00.000Z', updatedAt: '2026-07-21T09:00:00.000Z',
    };
    const cappedFailed = {
      bookingId: 'migration0013-capped-failed', kind: 'tourflow:booking.confirmed', status: 'failed',
      providerResultId: null, attemptCount: 12, attemptedAt: '2026-07-21T09:30:00.000Z',
      resolvedAt: '2026-07-21T09:30:05.000Z', error: 'Tourflow webhook request failed (503): gateway timeout',
      createdAt: '2026-07-21T05:00:00.000Z', updatedAt: '2026-07-21T09:30:05.000Z',
    };
    // A stale in_flight row at/over the cap must also become terminal: neither claim path can
    // reclaim it without exceeding the cap.
    const cappedInFlight = {
      bookingId: 'migration0013-capped-in-flight', kind: 'email_confirmation', status: 'in_flight',
      providerResultId: null, attemptCount: 11, attemptedAt: '2026-07-21T04:00:00.000Z',
      resolvedAt: null, error: null, createdAt: '2026-07-21T03:00:00.000Z', updatedAt: '2026-07-21T04:00:00.000Z',
    };
    for (const bookingId of [cappedPending.bookingId, cappedFailed.bookingId, cappedInFlight.bookingId]) await seedBooking(bookingId);
    await insertRow(cappedPending);
    await insertRow(cappedFailed);
    await insertRow(cappedInFlight);

    await applyD1Migrations(db, [migration0013], 'd1_migrations_0013_test');

    const ordinary = await db.prepare(
      `SELECT booking_id AS bookingId, kind, status, provider_result_id AS providerResultId, attempt_count AS attemptCount,
         attempted_at AS attemptedAt, resolved_at AS resolvedAt, error, created_at AS createdAt, updated_at AS updatedAt
       FROM side_effect_operations WHERE booking_id LIKE 'migration0013-ok-%' ORDER BY booking_id, kind`,
    ).all<typeof preservedRows[number]>();
    expect(ordinary.results).toEqual([...preservedRows].sort((a, b) => a.bookingId.localeCompare(b.bookingId) || a.kind.localeCompare(b.kind)));

    const convertedPending = await db.prepare(
      `SELECT status, attempt_count AS attemptCount, attempted_at AS attemptedAt, resolved_at AS resolvedAt, error, created_at AS createdAt, updated_at AS updatedAt
       FROM side_effect_operations WHERE booking_id = ?`,
    ).bind(cappedPending.bookingId).all<{ status: string; attemptCount: number; attemptedAt: string | null; resolvedAt: string | null; error: string | null; createdAt: string; updatedAt: string }>();
    expect(convertedPending.results).toEqual([{
      status: 'abandoned', attemptCount: 10, attemptedAt: cappedPending.attemptedAt,
      resolvedAt: cappedPending.updatedAt, error: 'max attempts (10) reached during upgrade to migration 0013',
      createdAt: cappedPending.createdAt, updatedAt: cappedPending.updatedAt,
    }]);

    const convertedFailed = await db.prepare(
      `SELECT status, attempt_count AS attemptCount, resolved_at AS resolvedAt, error
       FROM side_effect_operations WHERE booking_id = ?`,
    ).bind(cappedFailed.bookingId).all<{ status: string; attemptCount: number; resolvedAt: string | null; error: string | null }>();
    expect(convertedFailed.results).toEqual([{
      status: 'abandoned', attemptCount: 12,
      // Already had a resolved_at -- COALESCE keeps the original, not updated_at.
      resolvedAt: cappedFailed.resolvedAt, error: 'max attempts (10) reached during upgrade to migration 0013',
    }]);

    const convertedInFlight = await db.prepare(
      `SELECT status, attempt_count AS attemptCount, resolved_at AS resolvedAt, error
       FROM side_effect_operations WHERE booking_id = ?`,
    ).bind(cappedInFlight.bookingId).all<{ status: string; attemptCount: number; resolvedAt: string | null; error: string | null }>();
    expect(convertedInFlight.results).toEqual([{
      status: 'abandoned', attemptCount: 11, resolvedAt: cappedInFlight.updatedAt,
      error: 'max attempts (10) reached during upgrade to migration 0013',
    }]);

    // The rebuild's whole point: 'abandoned' is now a legal status, on the migrated (not freshly
    // created) table.
    await seedBooking('migration0013-fresh-abandoned');
    await expect(db.prepare(
      `INSERT INTO side_effect_operations (booking_id, kind, status, attempt_count, created_at, updated_at)
       VALUES (?, 'calendar_create', 'abandoned', 10, ?, ?)`,
    ).bind('migration0013-fresh-abandoned', '2026-07-21T11:00:00.000Z', '2026-07-21T11:00:00.000Z').run()).resolves.toBeDefined();

    await expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_side_effect_operations_pending'`,
    ).all<{ name: string }>()).resolves.toMatchObject({ results: [{ name: 'idx_side_effect_operations_pending' }] });

    await expect(db.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] });
  });
});
