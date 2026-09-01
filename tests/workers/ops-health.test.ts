// Tests the ops-health endpoint against real D1 — a migrated
// schema, real outbox debt, and a real open incident, read through the same runtime a deployment
// uses. The aggregate is SQL (a GROUP BY over the `family` column), so a fake repository
// would prove nothing about it.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminIdentity } from '../../src/access';
import type { ReservaContext } from '../../src/context';
import type { OpsHealthResponse } from '../../src/core/api';
import { handleOpsHealth } from '../../src/handlers';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';
import { config as baseConfig } from '../fixtures';
import { providers } from '../fakes';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const db = (env as unknown as TestEnv).RESERVA_DB;
const ADMIN_TOKEN_SECRET = 'TEST_OPS_HEALTH_TOKEN';
const ADMIN_TOKEN_VALUE = 'ops-health-admin-secret';

function configWithoutAccess(): typeof baseConfig {
  const { access: _omit, ...adminWithoutAccess } = baseConfig.admin;
  return { ...baseConfig, admin: adminWithoutAccess };
}

async function headerTokenAdminAuth(request: Request, context: ReservaContext): Promise<AdminIdentity | null> {
  const expected = await context.secrets?.(ADMIN_TOKEN_SECRET);
  const supplied = request.headers.get('x-admin-token');
  if (!expected || !supplied || supplied !== expected) return null;
  return { subject: 'ops-health-admin' };
}

const runtime = defineCloudflareReservaRuntime(configWithoutAccess(), {
  providers: providers(),
  adminAuth: headerTokenAdminAuth,
  secretBindings: ['RESERVA_OPERATOR_SECRET', ADMIN_TOKEN_SECRET],
});

const HEALTH_URL = 'https://example.test/api/booking/ops/health';

function healthRequest(headers: HeadersInit = {}): Request {
  return new Request(HEALTH_URL, { headers });
}

async function buildContext(request: Request): Promise<ReservaContext> {
  return runtime.createContext({
    request,
    locals: { env: { RESERVA_DB: db, [ADMIN_TOKEN_SECRET]: ADMIN_TOKEN_VALUE } },
  });
}

const BOOKING_ID = 'ops-health-booking';
const OLDEST_PENDING_AT = new Date(Date.now() - 3 * 3_600_000).toISOString();

async function seedDebt(context: ReservaContext): Promise<void> {
  const startsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await context.repo.insertHold({
    id: BOOKING_ID,
    reference: `LVT-OPS-${BOOKING_ID}`,
    serviceSlug: 'vintage',
    quantity: 2,
    pickupType: 'default',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    locale: 'en',
    priceMinor: 12000,
    currency: 'eur',
    holdExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    cancelToken: `cancel-${BOOKING_ID}`,
    operatorToken: `operator-${BOOKING_ID}`,
    createdAt: OLDEST_PENDING_AT,
    updatedAt: OLDEST_PENDING_AT,
  });
  // Undelivered work across three families and three non-succeeded statuses, plus one succeeded row
  // (which must not be counted) and one abandoned row (counted separately).
  const rows: Array<[string, string | null, string, string]> = [
    ['email', 'customer', 'pending', OLDEST_PENDING_AT],
    ['email', 'owner', 'failed', new Date(Date.now() - 3_600_000).toISOString()],
    ['webhook', 'crm', 'in_flight', new Date(Date.now() - 600_000).toISOString()],
    ['webhook', 'analytics', 'abandoned', new Date(Date.now() - 7_200_000).toISOString()],
    ['calendar_create', null, 'succeeded', new Date(Date.now() - 7_200_000).toISOString()],
  ];
  for (const [family, name, status, createdAt] of rows) {
    await db.prepare(
      `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, event_payload_json, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)`,
    ).bind(BOOKING_ID, family, name, family === 'calendar_create' ? null : 'booking.confirmed', status, createdAt, createdAt).run();
  }
  await context.repo.upsertOpenIncident({
    id: 'ops-health-incident',
    bookingId: BOOKING_ID,
    sourceType: 'side_effect',
    sourceKey: `${BOOKING_ID}:email:booking.confirmed:customer`,
    action: 'confirmation_email',
    severity: 'action_required',
    attemptCount: 3,
    sourceUpdatedAt: OLDEST_PENDING_AT,
    now: OLDEST_PENDING_AT,
    escalate: true,
  });
}

beforeEach(async () => {
  await db.prepare('DELETE FROM operational_incidents').run();
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
});

describe('GET /api/booking/ops/health (plan 027 design decision 7)', () => {
  it('403s without admin auth, and answers nothing about the deployment', async () => {
    const context = await buildContext(healthRequest());
    await seedDebt(context);
    const response = await handleOpsHealth(healthRequest(), context);
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain('outbox');
    expect(body).not.toContain('side_effect');
  });

  it('reports a migrated schema, outbox debt grouped by family, and open incidents', async () => {
    const context = await buildContext(healthRequest({ 'x-admin-token': ADMIN_TOKEN_VALUE }));
    await seedDebt(context);
    const response = await handleOpsHealth(healthRequest({ 'x-admin-token': ADMIN_TOKEN_VALUE }), context);
    expect(response.status).toBe(200);
    // Admin-gated, so it must never be cached by anything in front of it.
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await response.json() as OpsHealthResponse;

    // The suite runs against a database wrangler migrated, so the fingerprint check must pass.
    expect(payload.schema).toEqual({ ok: true, missingMigrations: [], fingerprintOk: true, detail: null });

    // 'succeeded' is settled and must not count as debt; 'abandoned' is terminal and counted apart.
    expect(payload.outbox.pending).toBe(3);
    expect(payload.outbox.abandoned).toBe(1);
    expect(payload.outbox.families).toEqual([
      { family: 'email', pending: 2, abandoned: 0 },
      { family: 'webhook', pending: 1, abandoned: 1 },
    ]);
    // ~3 hours, from the oldest UNDELIVERED row (the abandoned webhook row is older but settled).
    expect(payload.outbox.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(3 * 3600 - 60);
    expect(payload.outbox.oldestPendingAgeSeconds).toBeLessThan(3 * 3600 + 60);

    expect(payload.incidents).toEqual({ open: 1 });
  });

  it('reports a fully drained deployment with empty collections, not missing keys', async () => {
    const context = await buildContext(healthRequest({ 'x-admin-token': ADMIN_TOKEN_VALUE }));
    const response = await handleOpsHealth(healthRequest({ 'x-admin-token': ADMIN_TOKEN_VALUE }), context);
    const payload = await response.json() as OpsHealthResponse;
    expect(payload.outbox).toEqual({ pending: 0, abandoned: 0, oldestPendingAgeSeconds: null, families: [] });
    expect(payload.incidents.open).toBe(0);
  });

  it('carries no booking data and accepts no parameters', async () => {
    const context = await buildContext(healthRequest({ 'x-admin-token': ADMIN_TOKEN_VALUE }));
    await seedDebt(context);
    // A query string changes nothing: this is one fixed read, not a query API.
    const filtered = await handleOpsHealth(
      new Request(`${HEALTH_URL}?bookingId=${BOOKING_ID}&family=email`, { headers: { 'x-admin-token': ADMIN_TOKEN_VALUE } }),
      context,
    );
    const plain = await handleOpsHealth(healthRequest({ 'x-admin-token': ADMIN_TOKEN_VALUE }), context);
    const [filteredBody, plainBody] = await Promise.all([filtered.text(), plain.text()]);
    expect(JSON.parse(filteredBody).outbox).toEqual(JSON.parse(plainBody).outbox);
    expect(filteredBody).not.toContain(BOOKING_ID);
    expect(filteredBody).not.toContain('LVT-OPS');
  });

  it('is GET-only', async () => {
    const request = new Request(HEALTH_URL, { method: 'POST', headers: { 'x-admin-token': ADMIN_TOKEN_VALUE } });
    const context = await buildContext(request);
    const response = await handleOpsHealth(request, context);
    expect(response.status).toBe(405);
  });
});
