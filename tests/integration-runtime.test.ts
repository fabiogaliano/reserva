import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import config from '../examples/minimal/client-config';
import { defineCloudflareReservaRuntime, getCache, getEnv } from '../src/runtime-context';
import { RESERVA_MIGRATIONS } from '../src/migrations-manifest';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

describe('Cloudflare runtime helpers', () => {
  it('reads injected test bindings without exposing env on context', async () => {
    // Needs `prepare` to pass the D1 shape check, and `.all()` must resolve reserva's migrations
    // plus a matching schema fingerprint so context creation doesn't reject this fake as unmigrated.
    const db = {
      prepare: (query: string) => ({
        all: async () => {
          if (query.startsWith('PRAGMA table_info(bookings)')) {
            return { results: ['occupancy_units', 'cancel_token_hash', 'operator_token_hash', 'cancel_token_revoked_at', 'reschedule_transition_version', 'meeting_point_id', 'currency', 'metadata'].map((name) => ({ name })) };
          }
          if (query.includes("name IN ('bookings', 'idx_bookings_payment_ref')")) {
            return {
              results: [
                {
                  type: 'table', name: 'bookings',
                  sql: `CREATE TABLE bookings (
                    quantity INTEGER CHECK (quantity > 0), pickup_type TEXT,
                    starts_at TEXT, ends_at TEXT CHECK (ends_at > starts_at), price_minor INTEGER CHECK (price_minor >= 0),
                    currency TEXT NOT NULL, metadata TEXT,
                    status TEXT CHECK (status IN ('hold','confirmed','cancelled','expired','no_show')),
                    cancelled_by TEXT CHECK (cancelled_by IN ('customer','operator') OR cancelled_by IS NULL)
                  )`,
                },
                {
                  type: 'index', name: 'idx_bookings_payment_ref',
                  sql: 'CREATE UNIQUE INDEX idx_bookings_payment_ref ON bookings (payment_ref) WHERE payment_ref IS NOT NULL',
                },
              ],
            };
          }
          if (query.startsWith('PRAGMA table_info(side_effect_operations)')) {
            return { results: ['family', 'name', 'event', 'discriminator', 'event_payload_json', 'failure_started_at', 'next_attempt_at'].map((name) => ({ name })) };
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
                { type: 'table', name: 'side_effect_operations', sql: "CHECK (family IN ('calendar_create','calendar_delete','email_confirmation','oversell','email','hook','webhook')), status TEXT CHECK (status IN ('pending','in_flight','succeeded','failed','abandoned'))" },
                { type: 'index', name: 'idx_side_effect_operations_pending', sql: null },
                { type: 'index', name: 'idx_side_effect_operations_reconciliation', sql: null },
                { type: 'index', name: 'idx_side_effect_operations_identity', sql: null },
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
          return { results: RESERVA_MIGRATIONS.map((name) => ({ name })) };
        },
      }),
    } as unknown as D1Database;
    const cache = { match: async () => undefined, put: async () => undefined } as never;
    const definition = defineCloudflareReservaRuntime(config, { providers: { payments } });
    const request = new Request('https://example.test/api/booking/status');
    const context = await definition.createContext({
      request,
      locals: { env: { RESERVA_DB: db, RESERVA_CACHE: cache, RESERVA_OPERATOR_SECRET: 'secret' } },
    });
    expect(context.config).toStrictEqual(definition.config);
    expect(context.db).toBe(db);
    expect(context.cache).toBe(cache);
    expect('env' in context).toBe(false);
    await expect(context.secrets?.('RESERVA_OPERATOR_SECRET')).resolves.toBe('secret');
    await expect(context.secrets?.('STRIPE_SECRET_KEY')).resolves.toBeUndefined();

    const nextContext = await definition.createContext({
      request,
      locals: { env: { RESERVA_DB: db, RESERVA_CACHE: cache } },
    });
    expect(nextContext.confirmationLocks).toBe(context.confirmationLocks);
  });

  it('supports direct env locals and worker cache fallback', () => {
    const env = { RESERVA_DB: {} };
    expect(getEnv({ env })).toBe(env);
    expect(getCache({ env })).toBeUndefined();
  });

  it('rejects a missing D1 binding at context-creation time', async () => {
    const definition = defineCloudflareReservaRuntime(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: {} },
    })).rejects.toThrow('Cloudflare D1 binding RESERVA_DB is not configured');
  });

  it('rejects a misconfigured (non-D1-shaped) binding before it reaches the repository', async () => {
    // Simulates a typo'd binding name resolving to some other binding (e.g. a string secret)
    // rather than the D1 database: it must fail here, not with a later "db.prepare is not a function".
    const definition = defineCloudflareReservaRuntime(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: { RESERVA_DB: 'not-a-database' } },
    })).rejects.toThrow('Cloudflare D1 binding RESERVA_DB is not configured');
  });
});
