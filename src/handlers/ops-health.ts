import type {
  OpsHealthOutbox, OpsHealthReconciliation, OpsHealthResponse, OpsHealthSecurity, ReconciliationSummary,
} from '../core/api.js';
import { parseUtcInstant } from '../core/time.js';
import { accessAllowed, adminDevBypassActive } from '../admin-access.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { RECONCILIATION_CADENCE_MINUTES } from '../reconciliation.js';
import { reservaMigrationStatus } from '../schema-check.js';
import { CSRF_SECRET_ENV_NAME } from '../admin-csrf.js';
import { TOKEN_ENC_SECRET_NAME } from '../repo.js';
import type { SideEffectDebtByFamily } from '../repo.js';
import { HttpError, json } from '../http.js';
import { run, withSensitiveHeaders } from './shared.js';

// The ops group's read surface — a read-only answer to "is this deployment healthy and current?"
// It takes no parameters, returns no booking data, and mutates nothing; if it ever needs to, the
// design is wrong.

function outboxSummary(debt: readonly SideEffectDebtByFamily[], now: string): OpsHealthOutbox {
  let pending = 0;
  let abandoned = 0;
  let oldestPendingAt: string | null = null;
  for (const entry of debt) {
    pending += entry.pending;
    abandoned += entry.abandoned;
    if (entry.oldestPendingAt !== null && (oldestPendingAt === null || entry.oldestPendingAt < oldestPendingAt)) {
      oldestPendingAt = entry.oldestPendingAt;
    }
  }
  // Age, not a timestamp: "the oldest undelivered side effect has been waiting 4 hours" is the fact
  // an operator acts on, and it needs no clock-skew reasoning on the reader's side.
  const ageMs = oldestPendingAt === null ? null : parseUtcInstant(now).getTime() - parseUtcInstant(oldestPendingAt).getTime();
  return {
    pending,
    abandoned,
    oldestPendingAgeSeconds: ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000)),
    families: debt.map((entry) => ({ family: entry.family, pending: entry.pending, abandoned: entry.abandoned })),
  };
}

// Presence of the secret is the whole signal: both layers are opt-in and silently inert without it,
// which is precisely the posture an operator needs reported back.
export async function securityPosture(context: ReservaContext): Promise<OpsHealthSecurity> {
  const [csrfSecret, tokenEncKey] = await Promise.all([
    context.secrets?.(CSRF_SECRET_ENV_NAME),
    context.secrets?.(TOKEN_ENC_SECRET_NAME),
  ]);
  return {
    csrfTokenLayer: csrfSecret ? 'on' : 'off',
    tokenEncryption: tokenEncKey ? 'on' : 'off',
    adminAuth: adminDevBypassActive(context) ? 'dev-bypass' : context.config.admin.access ? 'access' : 'custom',
  };
}

// Three ticks of grace before calling the cron dead: one missed tick is a deploy or a cold start,
// three in a row is a missing trigger or a Worker that no longer boots.
const RECONCILIATION_STALE_AFTER_MS = 3 * RECONCILIATION_CADENCE_MINUTES * 60_000;
const RECONCILIATION_INCIDENT_SOURCE_KEY = 'reconciliation:sweep';

function parseSummary(serialized: string | null): ReconciliationSummary | null {
  if (serialized === null) return null;
  try {
    return JSON.parse(serialized) as ReconciliationSummary;
  } catch {
    // A summary this deployment can no longer parse is a reporting detail, never a reason to fail
    // the health read that an operator is using to diagnose something else.
    return null;
  }
}

// Detected on read rather than by the sweep itself: a sweep that has stopped running cannot report
// that it stopped running. Never-run (`lastRunAt === null`) counts as stale — that is exactly the
// state a deployment with no `triggers.crons` sits in.
async function reconciliationHealth(context: ReservaContext, now: string): Promise<OpsHealthReconciliation> {
  const lease = await context.repo.readReconciliationLease();
  const stale = lease.lastRunAt === null
    || parseUtcInstant(now).getTime() - parseUtcInstant(lease.lastRunAt).getTime() > RECONCILIATION_STALE_AFTER_MS;
  if (stale) {
    await context.repo.upsertOpenIncident({
      id: 'incident-reconciliation-stale',
      bookingId: null,
      sourceType: 'reconciliation',
      sourceKey: RECONCILIATION_INCIDENT_SOURCE_KEY,
      action: 'reconciliation_stale',
      severity: 'action_required',
      attemptCount: 0,
      // The last successful run is the source's own state, so a still-stale deployment re-detects
      // without escalating and re-alerting on every health poll.
      sourceUpdatedAt: lease.lastRunAt ?? 'never',
      now,
      escalate: false,
    });
  } else {
    await context.repo.resolveIncidentAutomatic('reconciliation', RECONCILIATION_INCIDENT_SOURCE_KEY, now);
  }
  return { lastRunAt: lease.lastRunAt, lastSummary: parseSummary(lease.lastSummary) };
}

export function handleOpsHealth(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    // The ops group's shared, fail-closed gate: inherits admin auth by consuming it, like every
    // operator endpoint, with no per-route wiring of its own.
    if (!(await accessAllowed(request, context))) throw new HttpError(403, 'forbidden', 'Admin authorization required');
    const now = nowIso(context);
    // Sequenced before the incident count so a `reconciliation_stale` opened by this very read is
    // already reflected in `incidents.open`.
    const reconciliation = await reconciliationHealth(context, now);
    const [schema, debt, openIncidents, security] = await Promise.all([
      reservaMigrationStatus(context.db),
      context.repo.countSideEffectDebtByFamily(),
      context.repo.countOpenIncidents(),
      securityPosture(context),
    ]);
    return json<OpsHealthResponse>({
      schema,
      outbox: outboxSummary(debt, now),
      incidents: { open: openIncidents },
      security,
      reconciliation,
    });
  }).then(withSensitiveHeaders);
}
