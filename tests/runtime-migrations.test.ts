import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import config from '../examples/client-config';
import { BOOKKIT_MIGRATIONS } from '../src/migrations-manifest';
import { checkBookkitMigrationsApplied, defineCloudflareBookkitRuntime, type MigrationsQueryable } from '../src/runtime-context';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionId: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => undefined,
};

// A fake standing in for the D1 surface the check uses: `db.prepare(sql).all()` returning
// `{ results }`, matching the real D1Database shape closely enough for this logic. It distinguishes
// the sqlite_master table-presence probe from the real `d1_migrations` select by query text, since
// the check now issues both as separate statements.
function fakeD1(
  appliedNames: string[],
  options: { missingTable?: boolean; selectError?: Error } = {},
): MigrationsQueryable {
  return {
    prepare: (query: string) => ({
      all: async <T>() => {
        if (query.includes('sqlite_master')) {
          return { results: (options.missingTable ? [] : [{ name: 'd1_migrations' }]) as T[] };
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
