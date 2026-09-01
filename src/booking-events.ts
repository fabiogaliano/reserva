// Booking events leave the library through exactly two primitives —
// in-process hooks a consumer registers on the runtime, and signed outbound webhooks declared in
// config. Both are the same thing to the outbox: a named subscriber whose delivery debt is one row
// carrying the identity `family`/`name`/`event` and the serialized envelope.
import { toWireBooking, type Booking } from './core/booking.js';
import type { WebhookEndpointConfig } from './core/config.js';
import {
  BOOKING_EVENT_API_VERSION,
  type BookingEvent,
  type BookingEventEnvelope,
  type BookingEventHook,
} from './core/events.js';
import type { ReservaContext } from './context.js';
import { getSecret } from './context.js';
import { ProviderFailure } from './provider-failure.js';
import { sideEffectOperationKey, type SideEffectOperationIdentity, type SideEffectOperationRecord, type SideEffectOperationSeed } from './repo.js';
import { deliverWebhook } from './webhooks.js';

function subscribes(events: readonly BookingEvent[] | undefined, event: BookingEvent): boolean {
  return events === undefined || events.includes(event);
}

export function hooksFor(context: ReservaContext, event: BookingEvent, durable: boolean): BookingEventHook[] {
  return (context.hooks ?? []).filter((hook) => Boolean(hook.durable) === durable && subscribes(hook.events, event));
}

function webhooksFor(context: ReservaContext, event: BookingEvent): WebhookEndpointConfig[] {
  return (context.config.webhooks ?? []).filter((endpoint) => subscribes(endpoint.events, event));
}

// Every subscriber that gets a durable outbox row for this event: durable hooks plus every webhook
// endpoint (a webhook is always durable — an HTTP call to somebody else's server is exactly what
// retries exist for).
export function durableSubscriberIdentities(context: ReservaContext, event: BookingEvent): SideEffectOperationIdentity[] {
  return [
    ...hooksFor(context, event, true).map((hook) => ({ family: 'hook' as const, name: hook.name, event })),
    ...webhooksFor(context, event).map((endpoint) => ({ family: 'webhook' as const, name: endpoint.name, event })),
  ];
}

export function bookingEventId(bookingId: string, identity: SideEffectOperationIdentity): string {
  return `${bookingId}/${sideEffectOperationKey(identity)}`;
}

export function buildBookingEventEnvelope(
  identity: SideEffectOperationIdentity,
  booking: Booking,
  occurredAt: string,
): BookingEventEnvelope {
  return {
    apiVersion: BOOKING_EVENT_API_VERSION,
    id: bookingEventId(booking.id, identity),
    event: identity.event as BookingEvent,
    occurredAt,
    data: { booking: toWireBooking(booking) },
  };
}

// The snapshot is taken here, once, from the booking as it will exist
// AFTER the transition this seed rides — not re-read at delivery time. `eventIdPrefix` carries the
// discriminator-free id so the repository can complete it inside the batch that assigns a
// reschedule version (see mutationSideEffectInsert).
export function bookingEventSeeds(
  context: ReservaContext,
  event: BookingEvent,
  booking: Booking,
  occurredAt: string,
  discriminator: string | null = null,
): SideEffectOperationSeed[] {
  return durableSubscriberIdentities(context, event).map((base) => ({
    ...base,
    discriminator,
    eventPayloadJson: JSON.stringify(buildBookingEventEnvelope({ ...base, discriminator }, booking, occurredAt)),
    // Discriminator-free on purpose: only the reschedule path leaves the discriminator to SQL, and
    // that is the one case where this prefix is used to finish the stored id.
    eventIdPrefix: bookingEventId(booking.id, base),
  }));
}

// Non-durable hooks fire post-commit and are never retried: one warning per failure, nothing
// persisted. This is what v1's ops/analytics sinks actually were.
export function dispatchNonDurableBookingEvent(
  context: ReservaContext,
  event: BookingEvent,
  booking: Booking,
  occurredAt: string,
): void {
  const hooks = hooksFor(context, event, false);
  if (hooks.length === 0) return;
  const wireBooking = toWireBooking(booking);
  const task = (async () => {
    for (const hook of hooks) {
      const identity = { family: 'hook' as const, name: hook.name, event };
      try {
        await hook.handler(event, wireBooking, {
          id: bookingEventId(booking.id, identity),
          occurredAt,
          config: context.config,
        });
      } catch (error) {
        context.logger.warn?.('reserva booking event hook failed', {
          event, bookingId: booking.id, hook: hook.name, error: String(error).slice(0, 200),
        });
      }
    }
  })();
  if (context.waitUntil) context.waitUntil(task);
  else void task;
}

// The unregistered-name rule: a durable row whose subscriber is no
// longer (or not yet) registered is a PERMANENT failure, so provider-failure classification
// (src/provider-failure.ts) abandons it on the spot instead of leaving it pending forever — and
// the abandonment log says exactly what to register to make it deliver.
function unregisteredSubscriber(identity: SideEffectOperationIdentity): ProviderFailure {
  const what = identity.family === 'hook'
    ? `register a durable booking-event hook named "${identity.name}" on the runtime`
    : `declare a webhook named "${identity.name}" in config.webhooks`;
  return new ProviderFailure({
    retryable: false,
    message: `No ${identity.family} named "${identity.name}" is registered, so ${sideEffectOperationKey(identity)} cannot be delivered: ${what}, or accept that this row is abandoned.`,
  });
}

// The delivery of one durable hook/webhook row. The stored envelope is authoritative and is sent
// byte-for-byte; only rows migration 0017 converted from the retired ops-sync provider have no
// snapshot, and they fall back to v1's behavior of describing the booking's current state.
export async function deliverBookingEventOperation(
  context: ReservaContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
): Promise<void> {
  const body = operation.eventPayloadJson
    ?? JSON.stringify(buildBookingEventEnvelope(operation, booking, booking.updatedAt));

  if (operation.family === 'hook') {
    const hook = (context.hooks ?? []).find((candidate) => candidate.durable && candidate.name === operation.name);
    if (!hook) throw unregisteredSubscriber(operation);
    const envelope = JSON.parse(body) as BookingEventEnvelope;
    await hook.handler(envelope.event, envelope.data.booking, {
      id: envelope.id,
      occurredAt: envelope.occurredAt,
      config: context.config,
    });
    return;
  }

  const endpoint = (context.config.webhooks ?? []).find((candidate) => candidate.name === operation.name);
  if (!endpoint) throw unregisteredSubscriber(operation);
  const secret = await getSecret(context, endpoint.secretBinding);
  if (!secret) {
    throw new ProviderFailure({
      retryable: false,
      message: `Webhook "${endpoint.name}" secret binding "${endpoint.secretBinding}" is unavailable: add it to the runtime's secretBindings and bind it as a Worker secret.`,
    });
  }
  const envelope = JSON.parse(body) as BookingEventEnvelope;
  await deliverWebhook({
    name: endpoint.name,
    url: endpoint.url,
    secret,
    id: envelope.id,
    body,
    now: context.clock(),
  });
}
