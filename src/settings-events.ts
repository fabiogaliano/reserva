// `settings.changed` delivery. Deliberately NOT the durable outbox: every row there is keyed by a
// booking, and a settings save has none. A missed rebuild is recovered by saving again or
// deploying by hand, so this trades durability for zero schema change — three attempts inside the
// admin request's own lifetime, then an error log and nothing else.
import type { ReservaContext } from './context.js';
import { getSecret, nowIso } from './context.js';
import {
  BOOKING_EVENT_API_VERSION,
  type SettingsChange,
  type SettingsEventEnvelope,
  type SettingsEventHookContext,
} from './core/events.js';
import { deliverWebhook } from './webhooks.js';

const SETTINGS_EVENT = 'settings.changed';

// Two retries inside the request lifetime: long enough to ride out a receiver restart, short
// enough that the admin's `waitUntil` budget is never the thing that fails.
const RETRY_DELAYS_MS = [2_000, 8_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

function subscribed(events: readonly string[] | undefined): boolean {
  // Explicit subscription only: an endpoint or hook that omits `events` means "every booking
  // event", which is what it meant before this event existed.
  return events !== undefined && events.includes(SETTINGS_EVENT);
}

export function buildSettingsChangedEnvelope(
  changeBatchId: string,
  occurredAt: string,
  changes: SettingsChange[],
): SettingsEventEnvelope {
  return {
    apiVersion: BOOKING_EVENT_API_VERSION,
    id: `settings/${changeBatchId}`,
    event: SETTINGS_EVENT,
    occurredAt,
    data: { changes },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverWithRetries(
  context: ReservaContext,
  endpoint: { name: string; url: string; secretBinding: string },
  envelope: SettingsEventEnvelope,
  body: string,
): Promise<void> {
  const secret = await getSecret(context, endpoint.secretBinding);
  if (!secret) {
    context.logger.error?.('settings webhook delivery failed', { name: endpoint.name, status: undefined });
    return;
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await deliverWebhook({ name: endpoint.name, url: endpoint.url, secret, id: envelope.id, body, now: context.clock() });
      return;
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof (error as { status: unknown }).status === 'number'
        ? (error as { status: number }).status
        : undefined;
      if (attempt === MAX_ATTEMPTS) {
        context.logger.error?.('settings webhook delivery failed', { name: endpoint.name, status });
        return;
      }
      await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    }
  }
}

// Fired once per admin save, from the POST handler, after the write landed. Detached through
// `waitUntil`: the operator's redirect never waits on somebody else's build system.
export function dispatchSettingsChanged(context: ReservaContext, changes: SettingsChange[]): void {
  if (changes.length === 0) return;
  const hooks = (context.hooks ?? []).filter((hook) => subscribed(hook.events));
  const endpoints = (context.config.webhooks ?? []).filter((endpoint) => subscribed(endpoint.events));
  if (hooks.length === 0 && endpoints.length === 0) return;

  const occurredAt = nowIso(context);
  const envelope = buildSettingsChangedEnvelope(crypto.randomUUID(), occurredAt, changes);
  const body = JSON.stringify(envelope);
  const hookContext: SettingsEventHookContext = { id: envelope.id, occurredAt, config: context.config, changes };

  const task = (async () => {
    for (const hook of hooks) {
      try {
        await hook.handler(SETTINGS_EVENT, null, hookContext);
      } catch (error) {
        context.logger.warn?.('reserva settings event hook failed', {
          hook: hook.name, error: String(error).slice(0, 200),
        });
      }
    }
    await Promise.all(endpoints.map((endpoint) => deliverWithRetries(context, endpoint, envelope, body)));
  })();
  if (context.waitUntil) context.waitUntil(task);
  else void task;
}
