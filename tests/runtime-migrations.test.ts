import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { RESERVA_MIGRATIONS, RESERVA_SCHEMA_TABLES } from '../src/generated/schema-fingerprint';
import { defineCloudflareReservaRuntime } from '../src/runtime-context';
import { checkReservaMigrationsApplied, type MigrationsQueryable } from '../src/schema-check';

// The runtime factory reads its config from `virtual:reserva/config` (plan item 12) instead of
// taking one; kept pointed at the published minimal example these tests used before.
vi.mock('virtual:reserva/config', async () => {
  const [{ default: config }, { resolveRouteConfig }] = await Promise.all([
    import('../examples/minimal/client-config'),
    import('../src/routes-manifest'),
  ]);
  return { default: { config, routes: resolveRouteConfig() } };
});

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

// The fingerprint is generated from migrations/*.sql (plan item 28), so a "fully migrated" fake is
// derived from it rather than hand-listing columns that drift with every migration. What the fake
// owns is the D1 response *shape* for the two queries the check makes.
function fingerprintResults(query: string, fingerprintOk: boolean): Array<Record<string, unknown>> | null {
  if (query.includes("type='index'")) {
    if (!fingerprintOk) return [];
    return Object.entries(RESERVA_SCHEMA_TABLES).flatMap(([table, { indexes }]) =>
      indexes.map((name) => ({ name, tbl_name: table })));
  }
  const pragma = query.match(/^PRAGMA table_info\((\w+)\)$/);
  if (!pragma) return null;
  // An empty column list is how a real database reports "this table isn't there", which is exactly
  // the consumer-migration collision the check has to catch.
  if (!fingerprintOk) return [];
  return (RESERVA_SCHEMA_TABLES[pragma[1]!]?.columns ?? []).map((name) => ({ name }));
}

// A fake for the D1 surface the check uses: `db.prepare(sql).all()` returning `{ results }`.
// Distinguishes the ledger probe, the fingerprint queries, and the `d1_migrations` select by query
// text. `schemaFingerprint` defaults to fully-migrated so ledger-only tests don't need to know about it.
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
        const fingerprint = fingerprintResults(query, fingerprintOk);
        if (fingerprint !== null) return { results: fingerprint as T[] };
        if (query.includes('sqlite_master')) {
          return { results: (options.missingTable ? [] : [{ name: tableName }]) as T[] };
        }
        if (options.selectError) throw options.selectError;
        return { results: appliedNames.map((name) => ({ name })) as T[] };
      },
    }),
  };
}

describe('checkReservaMigrationsApplied', () => {
  it('passes silently when every reserva migration is applied', async () => {
    await expect(checkReservaMigrationsApplied(fakeD1([...RESERVA_MIGRATIONS]))).resolves.toBeUndefined();
  });

  it('is tolerant of extra, consumer-owned migrations', async () => {
    const applied = [...RESERVA_MIGRATIONS, '0004_consumer_custom_table.sql'];
    await expect(checkReservaMigrationsApplied(fakeD1(applied))).resolves.toBeUndefined();
  });

  it('uses a configured migration table for both the probe and applied-names query, then the schema fingerprint', async () => {
    const queries: string[] = [];
    await expect(checkReservaMigrationsApplied(
      fakeD1([...RESERVA_MIGRATIONS], { tableName: 'reserva_migrations', queries }),
      'reserva_migrations',
    )).resolves.toBeUndefined();
    expect(queries).toEqual([
      "SELECT name FROM sqlite_master WHERE type='table' AND name='reserva_migrations'",
      'SELECT name FROM reserva_migrations',
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index'",
      ...Object.keys(RESERVA_SCHEMA_TABLES).map((table) => `PRAGMA table_info(${table})`),
    ]);
  });

  it('reports missing migrations after querying a configured migration table', async () => {
    const queries: string[] = [];
    await expect(checkReservaMigrationsApplied(
      fakeD1([], { tableName: 'reserva_migrations', queries }),
      'reserva_migrations',
    )).rejects.toThrow(/is missing/);
    expect(queries).toEqual([
      "SELECT name FROM sqlite_master WHERE type='table' AND name='reserva_migrations'",
      'SELECT name FROM reserva_migrations',
    ]);
  });

  it('fails with a distinct collision error when the ledger is satisfied but the schema fingerprint is missing', async () => {
    const db = fakeD1([...RESERVA_MIGRATIONS], { schemaFingerprint: false });
    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/migration ledger reports every migration applied, but the schema itself/);
    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    // Must not be conflated with the missing-migrations ledger error above.
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  it('rejects an unsafe configured migration table name', () => {
    expect(() => defineCloudflareReservaRuntime({
      providers: { payments },
      migrationsTable: 'd1_migrations; DROP TABLE bookings',
    })).toThrow(/migrationsTable.*SQLite identifier/);
  });

  it('names the missing migration and the apply command when one is unapplied', async () => {
    const applied = RESERVA_MIGRATIONS.filter((name) => name !== '0001_init.sql');
    await expect(checkReservaMigrationsApplied(fakeD1(applied))).rejects.toThrow(
      /0001_init\.sql.*wrangler d1 migrations apply <database_name> --local.*wrangler d1 migrations apply <database_name>.*reserva-migrate/s,
    );
  });

  it('names every migration and the same guidance when d1_migrations does not exist yet', async () => {
    await expect(checkReservaMigrationsApplied(fakeD1([], { missingTable: true }))).rejects.toThrow(
      new RegExp(RESERVA_MIGRATIONS.map((name) => name.replace(/\./g, '\\.')).join('.*'), 's'),
    );
  });

  it('propagates a transient error from the d1_migrations select as-is, rather than reporting missing migrations', async () => {
    const transientError = new Error('D1_ERROR: network connection lost');
    const db = fakeD1([], { selectError: transientError });
    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(transientError);
    // Specifically must NOT be recast as the missing-migrations guidance message.
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });
});

describe('migration check memoization', () => {
  it('does not permanently poison the isolate after a transient failure: a later request retries and succeeds', async () => {
    // First real select fails (simulating a transient DB hiccup); every subsequent select succeeds.
    let selectCalls = 0;
    const db = {
      prepare: (query: string) => ({
        all: async () => {
          // Schema fingerprint queries always report a fully-migrated schema here --
          // this test is about ledger memoization/retry, not the fingerprint itself.
          const fingerprint = fingerprintResults(query, true);
          if (fingerprint !== null) return { results: fingerprint };
          if (query.includes('sqlite_master')) return { results: [{ name: 'd1_migrations' }] };
          selectCalls += 1;
          if (selectCalls === 1) throw new Error('D1_ERROR: network connection lost');
          return { results: RESERVA_MIGRATIONS.map((name) => ({ name })) };
        },
      }),
    } as unknown as D1Database;
    const definition = defineCloudflareReservaRuntime({ providers: { payments } });
    const request = new Request('https://example.test/api/booking/status');
    const locals = { env: { RESERVA_DB: db } };

    await expect(definition.createContext({ request, locals })).rejects.toThrow('network connection lost');
    // If the failed check were still memoized, this second request would replay the same rejection
    // (or the misleading missing-migrations error) instead of retrying the now-healthy database.
    await expect(definition.createContext({ request, locals })).resolves.toBeDefined();
    expect(selectCalls).toBe(2);
  });
});
