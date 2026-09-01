import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import config from '../examples/client-config';
import { BOOKKIT_MIGRATIONS } from '../src/migrations-manifest';
import { checkBookkitMigrationsApplied, defineCloudflareBookkitRuntime, type MigrationsQueryable } from '../src/runtime-context';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

// Plan 008: the real column/table/index names the schema fingerprint checks for (see
// src/runtime-context.ts's REQUIRED_BOOKINGS_COLUMNS and sideEffectOperationsSchemaPresent).
// Duplicated here rather than imported since these are the fake's own PRAGMA/sqlite_master
// response shapes, not the implementation under test.
// Plan 017: meeting_point_id is 0014's addition to REQUIRED_BOOKINGS_COLUMNS.
// Plan 018 (design decision 5): migration 0015 removes the pickup_type CHECK (domain moved to
// config-declared option ids), so a "fully migrated" fake must NOT carry it -- the column itself
// stays, unconstrained, matching 0015's rebuilt schema.
// Plan 022: currency/metadata are 0018's additions, and the per-entity sync flags it dropped must
// be absent for a "fully migrated" fake -- the fingerprint reads their presence as the old shape.
const FINGERPRINT_BOOKINGS_COLUMNS = ['occupancy_units', 'cancel_token_hash', 'operator_token_hash', 'cancel_token_revoked_at', 'reschedule_transition_version', 'meeting_point_id', 'currency', 'metadata'];
const FINGERPRINT_BOOKINGS_SQL = `CREATE TABLE bookings (
  quantity INTEGER CHECK (quantity > 0), pickup_type TEXT,
  starts_at TEXT, ends_at TEXT CHECK (ends_at > starts_at), price_minor INTEGER CHECK (price_minor >= 0),
  currency TEXT NOT NULL, metadata TEXT,
  status TEXT CHECK (status IN ('hold','confirmed','cancelled','expired','no_show')),
  cancelled_by TEXT CHECK (cancelled_by IN ('customer','operator') OR cancelled_by IS NULL)
)`;
const FINGERPRINT_PAYMENT_INDEX_SQL = 'CREATE UNIQUE INDEX idx_bookings_payment_ref ON bookings (payment_ref) WHERE payment_ref IS NOT NULL';
// Plan 016: 'abandoned' is 0013's addition to the `status` CHECK. Plan 021: 0017 replaced `kind`
// with the structured identity columns and their family CHECK — all of it has to be present for a
// "fully migrated" fake fixture (fingerprintOk: true).
const FINGERPRINT_SIDE_EFFECT_SQL = "CREATE TABLE side_effect_operations (family TEXT CHECK (family IN ('calendar_create','calendar_delete','email_confirmation','oversell','email','hook','webhook')), status TEXT CHECK (status IN ('pending','in_flight','succeeded','failed','abandoned')))";
// Plan 020 (design decision 5): failure_started_at/next_attempt_at are 0016's additive columns on
// side_effect_operations. Plan 021: 0017's identity columns and the serialized event envelope.
const FINGERPRINT_SIDE_EFFECT_COLUMNS = ['family', 'name', 'event', 'discriminator', 'event_payload_json', 'failure_started_at', 'next_attempt_at'];
// Plan 020 (design decision 7): 0016's byte-preserving refund_operations rebuild widens `status`
// and appends the execution-lease/backoff columns.
const FINGERPRINT_REFUND_SQL = "CREATE TABLE refund_operations (status TEXT CHECK (status IN ('requested','in_flight','succeeded','failed','abandoned')))";
const FINGERPRINT_REFUND_COLUMNS = ['execution_claim_token', 'execution_claim_until', 'attempt_count', 'attempted_at', 'failure_started_at', 'next_attempt_at'];

// A fake standing in for the D1 surface the check uses: `db.prepare(sql).all()` returning
// `{ results }`, matching the real D1Database shape closely enough for this logic. It distinguishes
// the ledger's sqlite_master table-presence probe, the schema fingerprint's PRAGMA/sqlite_master
// queries, and the real `d1_migrations` select by query text, since the check now issues all of
// them as separate statements. `schemaFingerprint` defaults to a fully-migrated schema so tests
// that only care about the ledger don't need to know about the fingerprint at all.
function fakeD1(
  appliedNames: string[],
  options: { missingTable?: boolean; selectError?: Error; tableName?: string; queries?: string[]; schemaFingerprint?: boolean } = {},
): MigrationsQueryable {
  const tableName = options.tableName ?? 'd1_migrations';
  const fingerprintOk = options.schemaFingerprint ?? true;
  return {
    prepare: (query: string) => ({
      all: async <T>() => {
        options.queries?.push(query);
        if (query.startsWith('PRAGMA table_info(bookings)')) {
          return { results: (fingerprintOk ? FINGERPRINT_BOOKINGS_COLUMNS.map((name) => ({ name })) : []) as T[] };
        }
        if (query.startsWith('PRAGMA table_info(side_effect_operations)')) {
          return { results: (fingerprintOk ? FINGERPRINT_SIDE_EFFECT_COLUMNS.map((name) => ({ name })) : []) as T[] };
        }
        if (query.startsWith('PRAGMA table_info(refund_operations)')) {
          return { results: (fingerprintOk ? FINGERPRINT_REFUND_COLUMNS.map((name) => ({ name })) : []) as T[] };
        }
        if (query.includes("name IN ('bookings', 'idx_bookings_payment_ref')")) {
          return {
            results: (fingerprintOk ? [
              { type: 'table', name: 'bookings', sql: FINGERPRINT_BOOKINGS_SQL },
              { type: 'index', name: 'idx_bookings_payment_ref', sql: FINGERPRINT_PAYMENT_INDEX_SQL },
            ] : []) as T[],
          };
        }
        if (query.includes('idx_side_effect_operations_reconciliation')) {
          return {
            results: (fingerprintOk ? [
              { type: 'table', name: 'side_effect_operations', sql: FINGERPRINT_SIDE_EFFECT_SQL },
              { type: 'index', name: 'idx_side_effect_operations_pending', sql: null },
              { type: 'index', name: 'idx_side_effect_operations_reconciliation', sql: null },
              { type: 'index', name: 'idx_side_effect_operations_identity', sql: null },
            ] : []) as T[],
          };
        }
        if (query.includes('idx_refund_operations_reconciliation')) {
          return {
            results: (fingerprintOk ? [
              { type: 'table', name: 'refund_operations', sql: FINGERPRINT_REFUND_SQL },
              { type: 'index', name: 'idx_refund_operations_status', sql: null },
              { type: 'index', name: 'idx_refund_operations_reconciliation', sql: null },
            ] : []) as T[],
          };
        }
        if (query.includes('operational_incidents')) {
          return {
            results: (fingerprintOk ? [
              { type: 'table', name: 'operational_incidents' },
              { type: 'index', name: 'idx_operational_incidents_open' },
              { type: 'index', name: 'idx_operational_incidents_alert' },
            ] : []) as T[],
          };
        }
        if (query.includes('sqlite_master')) {
          return { results: (options.missingTable ? [] : [{ name: tableName }]) as T[] };
        }
        if (options.selectError) throw options.selectError;
        return { results: appliedNames.map((name) => ({ name })) as T[] };
      },
    }),
  };
}

describe('checkBookkitMigrationsApplied', () => {
  it('passes silently when every bookkit migration is applied', async () => {
    await expect(checkBookkitMigrationsApplied(fakeD1([...BOOKKIT_MIGRATIONS]))).resolves.toBeUndefined();
  });

  it('is tolerant of extra, consumer-owned migrations', async () => {
    const applied = [...BOOKKIT_MIGRATIONS, '0004_consumer_custom_table.sql'];
    await expect(checkBookkitMigrationsApplied(fakeD1(applied))).resolves.toBeUndefined();
  });

  it('uses a configured migration table for both the probe and applied-names query, then the schema fingerprint', async () => {
    const queries: string[] = [];
    await expect(checkBookkitMigrationsApplied(
      fakeD1([...BOOKKIT_MIGRATIONS], { tableName: 'bookkit_migrations', queries }),
      'bookkit_migrations',
    )).resolves.toBeUndefined();
    expect(queries).toEqual([
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bookkit_migrations'",
      'SELECT name FROM bookkit_migrations',
      'PRAGMA table_info(bookings)',
      "SELECT type, name, sql FROM sqlite_master WHERE name IN ('bookings', 'idx_bookings_payment_ref')",
      "SELECT type, name, sql FROM sqlite_master WHERE name IN ('side_effect_operations', 'idx_side_effect_operations_pending', 'idx_side_effect_operations_reconciliation', 'idx_side_effect_operations_identity')",
      'PRAGMA table_info(side_effect_operations)',
      "SELECT type, name, sql FROM sqlite_master WHERE name IN ('refund_operations', 'idx_refund_operations_status', 'idx_refund_operations_reconciliation')",
      'PRAGMA table_info(refund_operations)',
      "SELECT type, name FROM sqlite_master WHERE name IN ('operational_incidents', 'idx_operational_incidents_open', 'idx_operational_incidents_alert')",
    ]);
  });

  it('reports missing migrations after querying a configured migration table', async () => {
    const queries: string[] = [];
    await expect(checkBookkitMigrationsApplied(
      fakeD1([], { tableName: 'bookkit_migrations', queries }),
      'bookkit_migrations',
    )).rejects.toThrow(/is missing/);
    expect(queries).toEqual([
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bookkit_migrations'",
      'SELECT name FROM bookkit_migrations',
    ]);
  });

  it('fails with a distinct collision error when the ledger is satisfied but the schema fingerprint is missing', async () => {
    const db = fakeD1([...BOOKKIT_MIGRATIONS], { schemaFingerprint: false });
    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/migration ledger reports every migration applied, but the schema itself/);
    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    // Must not be conflated with the missing-migrations ledger error above.
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  it('rejects an unsafe configured migration table name', () => {
    expect(() => defineCloudflareBookkitRuntime(config, {
      providers: { payments },
      migrationsTable: 'd1_migrations; DROP TABLE bookings',
    })).toThrow(/migrationsTable.*SQLite identifier/);
  });

  it('names the missing migration and the apply command when one is unapplied', async () => {
    const applied = BOOKKIT_MIGRATIONS.filter((name) => name !== '0003_hold_ip.sql');
    await expect(checkBookkitMigrationsApplied(fakeD1(applied))).rejects.toThrow(
      /0003_hold_ip\.sql.*wrangler d1 migrations apply <database_name> --local.*wrangler d1 migrations apply <database_name>.*bookkit-migrate/s,
    );
  });

  it('names every migration and the same guidance when d1_migrations does not exist yet', async () => {
    await expect(checkBookkitMigrationsApplied(fakeD1([], { missingTable: true }))).rejects.toThrow(
      new RegExp(BOOKKIT_MIGRATIONS.map((name) => name.replace(/\./g, '\\.')).join('.*'), 's'),
    );
  });

  it('propagates a transient error from the d1_migrations select as-is, rather than reporting missing migrations', async () => {
    const transientError = new Error('D1_ERROR: network connection lost');
    const db = fakeD1([], { selectError: transientError });
    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(transientError);
    // Specifically must NOT be recast as the missing-migrations guidance message.
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });
});

describe('migration check memoization', () => {
  it('does not permanently poison the isolate after a transient failure: a later request retries and succeeds', async () => {
    // First real select fails (simulating a transient DB hiccup); every subsequent select succeeds.
    let selectCalls = 0;
    const db = {
      prepare: (query: string) => ({
        all: async () => {
          // Schema fingerprint queries (plan 008) always report a fully-migrated schema here --
          // this test is about ledger memoization/retry, not the fingerprint itself.
          if (query.startsWith('PRAGMA table_info(bookings)')) {
            return { results: FINGERPRINT_BOOKINGS_COLUMNS.map((name) => ({ name })) };
          }
          if (query.startsWith('PRAGMA table_info(side_effect_operations)')) {
            return { results: FINGERPRINT_SIDE_EFFECT_COLUMNS.map((name) => ({ name })) };
          }
          if (query.startsWith('PRAGMA table_info(refund_operations)')) {
            return { results: FINGERPRINT_REFUND_COLUMNS.map((name) => ({ name })) };
          }
          if (query.includes("name IN ('bookings', 'idx_bookings_payment_ref')")) {
            return {
              results: [
                { type: 'table', name: 'bookings', sql: FINGERPRINT_BOOKINGS_SQL },
                { type: 'index', name: 'idx_bookings_payment_ref', sql: FINGERPRINT_PAYMENT_INDEX_SQL },
              ],
            };
          }
          if (query.includes('idx_side_effect_operations_reconciliation')) {
            return {
              results: [
                { type: 'table', name: 'side_effect_operations', sql: FINGERPRINT_SIDE_EFFECT_SQL },
                { type: 'index', name: 'idx_side_effect_operations_pending', sql: null },
                { type: 'index', name: 'idx_side_effect_operations_reconciliation', sql: null },
                { type: 'index', name: 'idx_side_effect_operations_identity', sql: null },
              ],
            };
          }
          if (query.includes('idx_refund_operations_reconciliation')) {
            return {
              results: [
                { type: 'table', name: 'refund_operations', sql: FINGERPRINT_REFUND_SQL },
                { type: 'index', name: 'idx_refund_operations_status', sql: null },
                { type: 'index', name: 'idx_refund_operations_reconciliation', sql: null },
              ],
            };
          }
          if (query.includes('operational_incidents')) {
            return {
              results: [
                { type: 'table', name: 'operational_incidents' },
                { type: 'index', name: 'idx_operational_incidents_open' },
                { type: 'index', name: 'idx_operational_incidents_alert' },
              ],
            };
          }
          if (query.includes('sqlite_master')) return { results: [{ name: 'd1_migrations' }] };
          selectCalls += 1;
          if (selectCalls === 1) throw new Error('D1_ERROR: network connection lost');
          return { results: BOOKKIT_MIGRATIONS.map((name) => ({ name })) };
        },
      }),
    } as unknown as D1Database;
    const definition = defineCloudflareBookkitRuntime(config, { providers: { payments } });
    const request = new Request('https://example.test/api/booking/status');
    const locals = { env: { BOOKKIT_DB: db } };

    await expect(definition.createContext({ request, locals })).rejects.toThrow('network connection lost');
    // If the failed check were still memoized, this second request would replay the same rejection
    // (or the misleading missing-migrations error) instead of retrying the now-healthy database.
    await expect(definition.createContext({ request, locals })).resolves.toBeDefined();
    expect(selectCalls).toBe(2);
  });
});
