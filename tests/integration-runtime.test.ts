import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import config from '../examples/client-config';
import { defineCloudflareBookkitRuntime, getCache, getEnv } from '../src/runtime-context';
import { BOOKKIT_MIGRATIONS } from '../src/migrations-manifest';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionId: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundId: 're_test', amountCents: 0 }),
};

describe('Cloudflare runtime helpers', () => {
  it('reads injected test bindings without exposing env on context', async () => {
    // Needs a `prepare` function so it passes the D1 shape check `defineCloudflareBookkitRuntime` runs at
    // context-creation time, and `.all()` must resolve bookkit's own migrations (ledger) plus a
    // matching schema fingerprint (plan 008) so the isolate-time schema check (also run at context
    // creation) doesn't reject this fake as an unmigrated/colliding database.
    const db = {
      prepare: (query: string) => ({
        all: async () => {
          if (query.startsWith('PRAGMA table_info(bookings)')) {
            return { results: ['occupancy_units', 'cancel_token_hash', 'operator_token_hash', 'cancel_token_revoked_at', 'reschedule_transition_version', 'meeting_point_id'].map((name) => ({ name })) };
          }
          if (query.includes("name IN ('bookings', 'idx_bookings_payment_intent')")) {
            return {
              results: [
                {
                  type: 'table', name: 'bookings',
                  sql: `CREATE TABLE bookings (
                    people INTEGER CHECK (people > 0), pickup_type TEXT,
                    starts_at TEXT, ends_at TEXT CHECK (ends_at > starts_at), price_cents INTEGER CHECK (price_cents >= 0),
                    status TEXT CHECK (status IN ('hold','confirmed','cancelled','expired','no_show')),
                    calendar_synced INTEGER CHECK (calendar_synced IN (0,1)), email_synced INTEGER CHECK (email_synced IN (0,1)),
                    tourflow_synced INTEGER CHECK (tourflow_synced IN (0,1)),
                    cancelled_by TEXT CHECK (cancelled_by IN ('customer','operator') OR cancelled_by IS NULL)
                  )`,
                },
                {
                  type: 'index', name: 'idx_bookings_payment_intent',
                  sql: 'CREATE UNIQUE INDEX idx_bookings_payment_intent ON bookings (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL',
                },
              ],
            };
          }
          if (query.startsWith('PRAGMA table_info(side_effect_operations)')) {
            return { results: ['failure_started_at', 'next_attempt_at'].map((name) => ({ name })) };
          }
          if (query.startsWith('PRAGMA table_info(refund_operations)')) {
            return {
              results: ['execution_claim_token', 'execution_claim_until', 'attempt_count', 'attempted_at', 'failure_started_at', 'next_attempt_at']
                .map((name) => ({ name })),
            };
          }
          if (query.includes('idx_side_effect_operations_reconciliation')) {
            return {
              results: [
                { type: 'table', name: 'side_effect_operations', sql: "CHECK (kind IN ('calendar_create', 'calendar_delete', 'email_confirmation', 'oversell')), status TEXT CHECK (status IN ('pending','in_flight','succeeded','failed','abandoned'))" },
                { type: 'index', name: 'idx_side_effect_operations_pending', sql: null },
                { type: 'index', name: 'idx_side_effect_operations_reconciliation', sql: null },
              ],
            };
          }
          if (query.includes('idx_refund_operations_reconciliation')) {
            return {
              results: [
                { type: 'table', name: 'refund_operations', sql: "CHECK (status IN ('requested','in_flight','succeeded','failed','abandoned'))" },
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
          return { results: BOOKKIT_MIGRATIONS.map((name) => ({ name })) };
        },
      }),
    } as unknown as D1Database;
    const cache = { match: async () => undefined, put: async () => undefined } as never;
    const definition = defineCloudflareBookkitRuntime(config, { providers: { payments } });
    const request = new Request('https://example.test/api/booking/status');
    const context = await definition.createContext({
      request,
      locals: { env: { BOOKKIT_DB: db, BOOKKIT_CACHE: cache, TOURFLOW_SHARED_SECRET: 'secret' } },
    });
    expect(context.config).toStrictEqual(definition.config);
    expect(context.db).toBe(db);
    expect(context.cache).toBe(cache);
    expect('env' in context).toBe(false);
    await expect(context.secrets?.('TOURFLOW_SHARED_SECRET')).resolves.toBe('secret');
    await expect(context.secrets?.('STRIPE_SECRET_KEY')).resolves.toBeUndefined();

    const nextContext = await definition.createContext({
      request,
      locals: { env: { BOOKKIT_DB: db, BOOKKIT_CACHE: cache } },
    });
    expect(nextContext.confirmationLocks).toBe(context.confirmationLocks);
  });

  it('supports direct env locals and worker cache fallback', () => {
    const env = { BOOKKIT_DB: {} };
    expect(getEnv({ env })).toBe(env);
    expect(getCache({ env })).toBeUndefined();
  });

  it('rejects a missing D1 binding at context-creation time', async () => {
    const definition = defineCloudflareBookkitRuntime(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: {} },
    })).rejects.toThrow('Cloudflare D1 binding BOOKKIT_DB is not configured');
  });

  it('rejects a misconfigured (non-D1-shaped) binding before it reaches the repository', async () => {
    // Simulates a typo'd binding name resolving to some other binding (e.g. a string secret)
    // rather than the D1 database: it must fail here, not with a later "db.prepare is not a function".
    const definition = defineCloudflareBookkitRuntime(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: { BOOKKIT_DB: 'not-a-database' } },
    })).rejects.toThrow('Cloudflare D1 binding BOOKKIT_DB is not configured');
  });
});
