import type { OpsHealthOutbox, OpsHealthResponse } from '../core/api.js';
import { parseUtcInstant } from '../core/time.js';
import { accessAllowed } from '../admin-access.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { reservaMigrationStatus } from '../schema-check.js';
import type { SideEffectDebtByFamily } from '../repo.js';
import { HttpError, json } from '../http.js';
import { run, withSensitiveHeaders } from './shared.js';

// The ops group's read surface. One read-only answer to "is this deployment healthy and current?"
// for an operator — or an agent debugging a deployment — who would otherwise need raw SQL.
//
// It takes no parameters, returns no booking data, and mutates nothing. If it ever needs to, the
// design is wrong: this is a health check, not a query API.

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

export function handleOpsHealth(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    // The ops group's shared, fail-closed gate — this route inherits admin auth by
    // consuming it, exactly like every operator endpoint, with no per-route wiring of its own.
    if (!(await accessAllowed(request, context))) throw new HttpError(403, 'forbidden', 'Admin authorization required');
    const now = nowIso(context);
    const [schema, debt, openIncidents] = await Promise.all([
      reservaMigrationStatus(context.db),
      context.repo.countSideEffectDebtByFamily(),
      context.repo.countOpenIncidents(),
    ]);
    return json<OpsHealthResponse>({
      schema,
      outbox: outboxSummary(debt, now),
      incidents: { open: openIncidents },
    });
  }).then(withSensitiveHeaders);
}
