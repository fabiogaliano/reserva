// The sweep now has two entry points — the cron `scheduled` event and POST /api/booking/ops/reconcile
// — sharing one D1 lease row. Both halves are exercised here against real D1, because the lease is a
// compare-and-set UPDATE: an in-memory fake would prove nothing about who actually wins it.
import { env } from 'cloudflare:workers';
import virtualConfig from 'virtual:reserva/config';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminIdentity } from '../../src/access';
import type { ReservaContext, ReservaLogger } from '../../src/context';
import { createReservaContext } from '../../src/context';
import type { OpsHealthResponse, ReconciliationSummary } from '../../src/core/api';
import { handleOpsHealth, handleOpsReconcile } from '../../src/handlers';
import { scheduledHandler } from '../../src/reconciliation';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';
import { providers } from '../fakes';

interface TestEnv {
  RESERVA_DB: D1Database;
}

// Cloudflare Access cannot be reached from workerd, and this route's point is the *operator bearer*
// path anyway, so `admin.access` is swapped out of `virtual:reserva/config` for a custom adminAuth —
// the other identity the route accepts. (`vi.mock` cannot reach it: the workers pool evaluates its
// `main` entry before the test module, so src/runtime-context is already bound to the real one.)
const { access: _omitAccess, ...adminWithoutAccess } = virtualConfig.config.admin;
virtualConfig.config = { ...virtualConfig.config, admin: adminWithoutAccess };

const db = (env as unknown as TestEnv).RESERVA_DB;
const OPERATOR_SECRET = 'ops-reconcile-operator-secret';
const ADMIN_TOKEN_SECRET = 'TEST_OPS_RECONCILE_TOKEN';
const ADMIN_TOKEN_VALUE = 'ops-reconcile-admin-secret';
const RECONCILE_URL = 'https://example.test/api/booking/ops/reconcile';

const alerted: unknown[] = [];
const warnings: Array<{ message: string; detail: unknown }> = [];
const logger: ReservaLogger = {
  warn: (message, detail) => { warnings.push({ message, detail }); },
};

async function headerTokenAdminAuth(request: Request, context: ReservaContext): Promise<AdminIdentity | null> {
  const expected = await context.secrets?.(ADMIN_TOKEN_SECRET);
  const supplied = request.headers.get('x-admin-token');
  if (!expected || !supplied || supplied !== expected) return null;
  return { subject: 'ops-reconcile-admin' };
}

const runtime = defineCloudflareReservaRuntime({
  providers: () => ({ ...providers(), alerts: { async send(alert) { alerted.push(alert); } } }),
  adminAuth: headerTokenAdminAuth,
  logger,
  secretBindings: ['RESERVA_OPERATOR_SECRET', ADMIN_TOKEN_SECRET],
});

function buildContext(request: Request): Promise<ReservaContext> {
  return Promise.resolve(runtime.createContext({
    request,
    locals: { env: { RESERVA_DB: db, RESERVA_OPERATOR_SECRET: OPERATOR_SECRET, [ADMIN_TOKEN_SECRET]: ADMIN_TOKEN_VALUE } },
  }));
}

function reconcileRequest(headers: HeadersInit = {}): Request {
  return new Request(RECONCILE_URL, { method: 'POST', headers });
}

function operatorHeaders(): HeadersInit {
  return { authorization: `Bearer ${OPERATOR_SECRET}` };
}

async function seedExpiredHold(context: ReservaContext, id: string): Promise<void> {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  await context.repo.insertHold({
    id,
    reference: `LVT-REC-${id}`,
    serviceSlug: 'vintage',
    quantity: 2,
    pickupType: 'default',
    startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString(),
    locale: 'en',
    priceMinor: 12000,
    currency: 'eur',
    holdExpiresAt: past,
    cancelToken: `cancel-${id}`,
    operatorToken: `operator-${id}`,
    createdAt: past,
    updatedAt: past,
  });
}

// Deployment-wide state: left behind by another file (or another case here) the lease would decide
// who wins before the test under it ever ran.
async function resetLease(): Promise<void> {
  await db.prepare(
    "UPDATE reconciliation_lease SET lease_token = NULL, lease_until = NULL, last_run_at = NULL, last_summary = NULL WHERE id = 'singleton'",
  ).run();
}

beforeEach(async () => {
  await db.prepare('DELETE FROM operational_incidents').run();
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  await resetLease();
  alerted.length = 0;
  warnings.length = 0;
});

describe('POST /api/booking/ops/reconcile', () => {
  it('403s without operator or admin authorization, and sweeps nothing', async () => {
    const context = await buildContext(reconcileRequest());
    await seedExpiredHold(context, 'reconcile-unauthorized');

    const response = await handleOpsReconcile(reconcileRequest(), context);
    expect(response.status).toBe(403);
    await expect(context.repo.getBookingById('reconcile-unauthorized')).resolves.toMatchObject({ status: 'hold' });
    await expect(context.repo.readReconciliationLease()).resolves.toMatchObject({ lastRunAt: null });
  });

  it('runs the sweep for an operator bearer and answers with the summary', async () => {
    const context = await buildContext(reconcileRequest(operatorHeaders()));
    await seedExpiredHold(context, 'reconcile-bearer');

    const response = await handleOpsReconcile(reconcileRequest(operatorHeaders()), context);
    expect(response.status).toBe(200);
    // Admin-gated work, so nothing in front of it may cache the answer.
    expect(response.headers.get('cache-control')).toBe('no-store');
    const summary = await response.json() as ReconciliationSummary;
    expect(summary.expiredHoldsSwept).toBe(1);
    await expect(context.repo.getBookingById('reconcile-bearer')).resolves.toMatchObject({ status: 'expired' });
  });

  it('accepts an admin identity too, so the dashboard can trigger the same sweep', async () => {
    const headers = { 'x-admin-token': ADMIN_TOKEN_VALUE };
    const context = await buildContext(reconcileRequest(headers));
    await seedExpiredHold(context, 'reconcile-admin');

    const response = await handleOpsReconcile(reconcileRequest(headers), context);
    expect(response.status).toBe(200);
    await expect(context.repo.getBookingById('reconcile-admin')).resolves.toMatchObject({ status: 'expired' });
  });

  it('releases the lease on success, and ops health reports the run', async () => {
    const context = await buildContext(reconcileRequest(operatorHeaders()));
    await handleOpsReconcile(reconcileRequest(operatorHeaders()), context);

    // Released, not held: the next trigger must not get a 409 from a sweep that already finished.
    const lease = await context.repo.readReconciliationLease();
    expect(lease.lastRunAt).not.toBeNull();

    const healthRequest = new Request('https://example.test/api/booking/ops/health', { headers: { 'x-admin-token': ADMIN_TOKEN_VALUE } });
    const healthContext = await buildContext(healthRequest);
    const health = await (await handleOpsHealth(healthRequest, healthContext)).json() as OpsHealthResponse;
    expect(health.reconciliation.lastRunAt).toBe(lease.lastRunAt);
    expect(health.reconciliation.lastSummary).toMatchObject({ expiredHoldsSwept: 0 });
  });

  it('409s with reconciliation_in_progress while another sweep holds the lease', async () => {
    const context = await buildContext(reconcileRequest(operatorHeaders()));
    const now = new Date().toISOString();
    const held = await context.repo.acquireReconciliationLease(
      'someone-elses-token', now, new Date(Date.parse(now) + 4 * 60_000).toISOString(),
    );
    expect(held).toBe(true);
    await seedExpiredHold(context, 'reconcile-busy');

    const response = await handleOpsReconcile(reconcileRequest(operatorHeaders()), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'reconciliation_in_progress' } });
    // The losing caller must not have done half the work on its way to the 409.
    await expect(context.repo.getBookingById('reconcile-busy')).resolves.toMatchObject({ status: 'hold' });
  });

  it('503s when the deployment has no operational alert sink', async () => {
    // Built directly rather than through the runtime: the runtime is where an alert sink gets wired,
    // and this is the deployment that never got one.
    const context = createReservaContext({ config: runtime.config, db, providers: providers() });
    const response = await handleOpsReconcile(reconcileRequest(operatorHeaders()), {
      ...context,
      secrets: async (name) => (name === 'RESERVA_OPERATOR_SECRET' ? OPERATOR_SECRET : undefined),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { message: 'operational alert sink not configured' } });
  });

  it('is POST-only', async () => {
    const request = new Request(RECONCILE_URL, { headers: operatorHeaders() });
    const context = await buildContext(request);
    const response = await handleOpsReconcile(request, context);
    expect(response.status).toBe(405);
  });
});

describe('the cron scheduled() entry shares the same lease', () => {
  it('sweeps on a normal tick', async () => {
    const seedContext = await buildContext(reconcileRequest(operatorHeaders()));
    await seedExpiredHold(seedContext, 'scheduled-tick');

    await scheduledHandler(runtime)({} as ScheduledController, env, {} as ExecutionContext);

    await expect(seedContext.repo.getBookingById('scheduled-tick')).resolves.toMatchObject({ status: 'expired' });
  });

  it('exits successfully with a warning when the route is already sweeping, rather than failing the invocation', async () => {
    const context = await buildContext(reconcileRequest(operatorHeaders()));
    const now = new Date().toISOString();
    await context.repo.acquireReconciliationLease('route-token', now, new Date(Date.parse(now) + 4 * 60_000).toISOString());
    await seedExpiredHold(context, 'scheduled-skipped');

    // Resolving (not throwing) is the assertion: a thrown error would record a failed cron
    // invocation for work another entry point is already doing.
    await expect(scheduledHandler(runtime)({} as ScheduledController, env, {} as ExecutionContext)).resolves.toBeUndefined();

    await expect(context.repo.getBookingById('scheduled-skipped')).resolves.toMatchObject({ status: 'hold' });
    expect(warnings.some((entry) => entry.message.includes('reconciliation skipped'))).toBe(true);
  });
});
