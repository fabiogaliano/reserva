#!/usr/bin/env bun
// Proves the *real* scheduled() dispatch path — not a direct runReconciliation() function call —
// recovers owed side-effect debt and resolves an already-open operator incident, against the
// standalone cron Worker template (examples/smoke-site/worker/) and its isolated D1, the same way
// `bun run cron:dev`+`bun run cron:trigger` do interactively.
//
// Mechanism: `wrangler dev --test-scheduled` exposes `GET /__scheduled`, Wrangler's own local
// route for triggering a Worker's scheduled() handler (see
// node_modules/wrangler/wrangler-dist/cli.js's `testScheduled` wiring) — this is the boundary
// local workerd actually supports for scheduled events; there is no Astro-preview equivalent,
// which is why this exercises the cron Worker directly with `wrangler dev` rather than trying to
// route the trigger through `astro preview`.
//
// Fixture shape: a confirmed booking with one calendar_create row already recorded as `failed`
// (attempt 2, past both its backoff window and the ten-minute delayed-incident threshold) and an
// already-open `delayed` incident for it — the state two consecutive 5-minute cron ticks would
// leave behind in production (tick 1 opens the incident; tick 2 is the one under test). The smoke
// site's calendar provider (examples/smoke-site/src/runtime.ts) never fails, so the real scheduled
// dispatch is expected to redrive the row to `succeeded` and auto-resolve the incident.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import { getPlatformProxy } from 'wrangler';
import { createReservaContext } from '../src/context';
import type { ReservaProviders } from '../src/context';

const smokeSiteRoot = fileURLToPath(new URL('../examples/smoke-site/', import.meta.url));
const workerConfigPath = fileURLToPath(new URL('../examples/smoke-site/worker/wrangler.jsonc', import.meta.url));
// Isolated from the interactive demo (.wrangler/state), the Playwright e2e suite (.wrangler-e2e),
// and scripts/smoke-preview-test.ts (.wrangler-preview-test) -- this probe's D1 state must never
// leak into, or be polluted by, any of those.
const PERSIST_DIR = '.wrangler-scheduled-test';
const persistPath = fileURLToPath(new URL(PERSIST_DIR, `file://${smokeSiteRoot}`));
// getPlatformProxy's own persist root does NOT auto-append 'v3' the way wrangler's CLI
// --persist-to (used by reserva-migrate.ts and 'wrangler dev' below) does -- append it by hand so
// both tools agree on the same on-disk D1 file.
const apiPersistPath = `${persistPath}/v3`;
const HOST = '127.0.0.1';
const PORT = 4397;
const triggerUrl = `http://${HOST}:${PORT}/__scheduled?cron=*+*+*+*+*`;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: smokeSiteRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'null'} (signal ${result.signal ?? 'none'})`);
  }
}

rmSync(persistPath, { recursive: true, force: true });
run('bun', ['../../scripts/reserva-migrate.ts', '--local', '--persist-to', PERSIST_DIR]);

// Never actually called: seeding uses only repo methods that don't dispatch to providers
// (insertHold/transitionToConfirmed), and the recovery itself runs inside the separately spawned
// cron Worker process, with its own real provider wiring (examples/smoke-site/src/runtime.ts).
const unusedProviders: ReservaProviders = {
  payments: {
    createCheckout: async () => { throw new Error('unused'); },
    parseWebhook: async () => { throw new Error('unused'); },
    getSession: async () => { throw new Error('unused'); },
    refund: async () => { throw new Error('unused'); },
  },
};

async function seedAndAssert(): Promise<void> {
  const proxy = await getPlatformProxy({ configPath: workerConfigPath, persist: { path: apiPersistPath } });
  try {
    const db = proxy.env.RESERVA_DB as unknown as D1Database;
    const config = (await import('../examples/smoke-site/src/config')).default;
    const now = '2026-08-14T10:00:00.000Z';
    const context = createReservaContext({ config, db, providers: unusedProviders, clock: () => new Date(now) });
    const id = 'smoke-scheduled-recovery';

    await context.repo.insertHold({
      id, reference: `BKT-2026-${id}`, serviceSlug: 'oldTown', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-20T09:00:00.000Z', endsAt: '2026-08-20T10:00:00.000Z', locale: 'en',
      priceMinor: 12000, currency: 'eur', holdExpiresAt: '2026-08-14T09:00:00.000Z',
      cancelToken: `cancel-${id}`, operatorToken: `operator-${id}`,
      createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T08:00:00.000Z',
    });
    await context.repo.transitionToConfirmed(id, { expectedStatusIn: ['hold'], paymentRef: `pi_${id}`, updatedAt: '2026-08-14T08:01:00.000Z' });

    // A failed attempt from ~11 minutes ago: past attempt 2's 10-minute backoff window
    // (RETRY_BACKOFF_MINUTES, src/reconciliation-helpers.ts) and past the 10-minute delayed-
    // incident threshold, so both the retry gate and the incident-already-open precondition hold.
    await db.prepare(
      `INSERT INTO side_effect_operations (booking_id, family, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at, failure_started_at, next_attempt_at)
       VALUES (?, 'calendar_create', 'failed', NULL, 2, ?, NULL, 'calendar unavailable', ?, ?, ?, NULL)`,
    ).bind(id, '2026-08-14T09:49:00.000Z', '2026-08-14T09:30:00.000Z', '2026-08-14T09:49:00.000Z', '2026-08-14T09:49:00.000Z').run();

    await db.prepare(
      `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, attempt_count, first_detected_at, last_detected_at, source_updated_at, alert_revision, alerted_revision, alert_attempt_count)
       VALUES (?, ?, 'side_effect', ?, 'calendar', 'open', 'delayed', 2, ?, ?, ?, 1, 0, 0)`,
    ).bind(`incident-${id}`, id, `${id}:calendar_create`, '2026-08-14T09:49:00.000Z', '2026-08-14T09:49:00.000Z', '2026-08-14T09:49:00.000Z').run();

    console.log('smoke-scheduled-test: seeded a confirmed booking with an owed, incident-open calendar_create row');
  } finally {
    await proxy.dispose();
  }
}

async function waitForScheduledTrigger(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(triggerUrl);
      if (response.status === 200) return;
      throw new Error(`GET /__scheduled returned ${response.status}`);
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`could not trigger the scheduled event within ${timeoutMs}ms: ${String(error)}`);
      await delay(250);
    }
  }
}

async function assertRecovered(): Promise<void> {
  const proxy = await getPlatformProxy({ configPath: workerConfigPath, persist: { path: apiPersistPath } });
  try {
    const db = proxy.env.RESERVA_DB as unknown as D1Database;
    const id = 'smoke-scheduled-recovery';
    // The event id the recovery wrote is the record that the calendar entry now exists, alongside
    // the row's own 'succeeded' status.
    const operation = await db.prepare('SELECT side_effect_operations.status AS status, bookings.calendar_event_id AS calendar_event_id FROM side_effect_operations JOIN bookings ON bookings.id = side_effect_operations.booking_id WHERE side_effect_operations.booking_id = ? AND side_effect_operations.family = ?').bind(id, 'calendar_create').first<{ status: string; calendar_event_id: string | null }>();
    if (!operation) throw new Error('side_effect_operations row disappeared');
    if (operation.status !== 'succeeded') throw new Error(`expected the real scheduled() dispatch to redrive the owed calendar_create row to 'succeeded', got '${operation.status}'`);
    if (operation.calendar_event_id === null) throw new Error('expected bookings.calendar_event_id to be set once the calendar_create row succeeded');

    const incident = await db.prepare('SELECT status, resolution_kind FROM operational_incidents WHERE booking_id = ?').bind(id).first<{ status: string; resolution_kind: string | null }>();
    if (!incident) throw new Error('operational_incidents row disappeared');
    if (incident.status !== 'resolved' || incident.resolution_kind !== 'automatic') {
      throw new Error(`expected the already-open incident to auto-resolve, got status='${incident.status}' resolution_kind='${incident.resolution_kind}'`);
    }

    console.log('smoke-scheduled-test: the real scheduled() dispatch recovered the owed operation and auto-resolved the open incident');
  } finally {
    await proxy.dispose();
  }
}

await seedAndAssert();

const cronWorker = spawn('bunx', ['wrangler', 'dev', '--config', 'worker/wrangler.jsonc', '--persist-to', PERSIST_DIR, '--test-scheduled', '--port', String(PORT)], {
  cwd: smokeSiteRoot,
  stdio: 'inherit',
});
let exited = false;
cronWorker.on('exit', () => { exited = true; });

try {
  if (exited) throw new Error('wrangler dev exited before becoming ready');
  await waitForScheduledTrigger(30_000);
  await assertRecovered();
  console.log('smoke-scheduled-test: OK');
} finally {
  cronWorker.kill('SIGTERM');
  const stopDeadline = Date.now() + 5_000;
  while (!exited && Date.now() < stopDeadline) await delay(100);
  if (!exited) cronWorker.kill('SIGKILL');
  if (!process.env.RESERVA_SCHEDULED_TEST_KEEP && existsSync(persistPath)) {
    rmSync(persistPath, { recursive: true, force: true });
  }
}
