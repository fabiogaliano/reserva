import type { Booking } from '../../src/core/booking';
import type { BookingEventHook } from '../../src/core/events';
import type { CalEvent } from '../../src/core/occupancy';
import { handlePaymentWebhook } from '../../src/handlers';
import { stripe } from '@reservajs/stripe';
import { defineCloudflareReservaRuntime, type ReservaProviders } from '../../src/runtime';
import config from '../../examples/minimal/client-config';

// `main` in wrangler.test.jsonc: a real worker entrypoint assembling the production stack and
// dispatching the real route to handlePaymentWebhook, so webhook.test.ts exercises runtime +
// handler + D1 together. Never contacts Stripe's API — signature verification is local.
export const WEBHOOK_SECRET = 'whsec_test_reserva_worker_stripe';
const STRIPE_TEST_SECRET_KEY = 'sk_test_reserva_worker';

// In-memory outboxes the test file asserts against — module-scoped because this worker's
// provider instances are constructed once, per examples/minimal/runtime.ts's pattern.
export const calendarEvents = new Map<string, CalEvent>();
export const emailOutbox: Array<{ event: string; bookingId: string }> = [];
export const hookOutbox: Array<{ event: string; bookingId: string }> = [];

export function resetWebhookWorkerOutboxes(): void {
  calendarEvents.clear();
  emailOutbox.length = 0;
  hookOutbox.length = 0;
}

const providers: ReservaProviders = {
  payments: stripe({ secretKey: STRIPE_TEST_SECRET_KEY, webhookSecret: WEBHOOK_SECRET }),
  calendar: {
    async listEvents() {
      return [...calendarEvents.values()];
    },
    async createEvent(booking: Booking) {
      const id = `cal_${booking.id}`;
      calendarEvents.set(id, { id, start: booking.startsAt, end: booking.endsAt, reservaBookingId: booking.id });
      return id;
    },
    async patchEvent(eventId: string, booking: Booking) {
      calendarEvents.set(eventId, { id: eventId, start: booking.startsAt, end: booking.endsAt, reservaBookingId: booking.id });
    },
    async deleteEvent(eventId: string) {
      calendarEvents.delete(eventId);
    },
  },
  email: {
    async send(event, booking) {
      emailOutbox.push({ event, bookingId: booking.id });
    },
  },
};

// A durable hook, so its delivery rides the same outbox row (and the same D1 batch as the
// confirmation) the production stack uses for a webhook subscriber.
const hooks: BookingEventHook[] = [{
  name: 'ops',
  durable: true,
  async handler(event, booking) {
    hookOutbox.push({ event, bookingId: booking.id });
  },
}];

const runtime = defineCloudflareReservaRuntime(config, { providers, hooks });

export default {
  // Standard modules-format signature (env/ctx unused) — kept so webhook.test.ts can dispatch
  // through createExecutionContext()/waitOnExecutionContext() like a real modules-format worker.
  async fetch(request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The one route this worker exists to exercise end to end (src/routes-manifest.ts
    // 'webhooksPayment' pattern) -- everything else 404s rather than growing into a second,
    // divergent copy of the Astro route table (that stays tests/integration-entry.test.ts's job).
    if (url.pathname === '/api/booking/webhooks/payment') {
      const context = await runtime.createContext({ request });
      return handlePaymentWebhook(request, context);
    }
    return new Response('Not found', { status: 404 });
  },
};
