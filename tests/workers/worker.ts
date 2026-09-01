import type { Booking } from '../../src/core/booking';
import type { BookingEventHook } from '../../src/core/events';
import type { CalEvent } from '../../src/core/occupancy';
import { handleStripeWebhook } from '../../src/handlers';
import { StripeProvider } from '../../src/providers/stripe';
import { defineCloudflareBookkitRuntime, type BookkitProviders } from '../../src/runtime';
import config from '../../examples/client-config';

// Plan 015: this is `main` in wrangler.test.jsonc -- a real worker entrypoint that assembles the
// production stack (defineCloudflareBookkitRuntime against the real D1 binding, a real
// StripeProvider doing real HMAC signature verification) and dispatches the exact production route
// to handleStripeWebhook, so tests/workers/webhook.test.ts exercises runtime + handler + D1
// together instead of any one layer in isolation. Never contacts Stripe's API: parseWebhook only
// verifies a signature against WEBHOOK_SECRET locally, and this worker never calls
// createCheckout/getSession/refund, so a fixed, non-secret test key is fine here.
export const WEBHOOK_SECRET = 'whsec_test_bookkit_worker_stripe';
const STRIPE_TEST_SECRET_KEY = 'sk_test_bookkit_worker';

// In-memory outboxes the test file asserts against and resets between cases -- module-scoped
// (rather than per-request) because this worker's provider instances are constructed once, same as
// examples/runtime.ts's documented pattern (README "Runtime module": per-request construction is a
// consumer choice, not a requirement).
export const calendarEvents = new Map<string, CalEvent>();
export const emailOutbox: Array<{ event: string; bookingId: string }> = [];
export const hookOutbox: Array<{ event: string; bookingId: string }> = [];

export function resetWebhookWorkerOutboxes(): void {
  calendarEvents.clear();
  emailOutbox.length = 0;
  hookOutbox.length = 0;
}

const providers: BookkitProviders = {
  payments: new StripeProvider({ secretKey: STRIPE_TEST_SECRET_KEY, webhookSecret: WEBHOOK_SECRET }),
  calendar: {
    async listEvents() {
      return [...calendarEvents.values()];
    },
    async createEvent(booking: Booking) {
      const id = `cal_${booking.id}`;
      calendarEvents.set(id, { id, start: booking.startsAt, end: booking.endsAt, bookkitBookingId: booking.id });
      return id;
    },
    async patchEvent(eventId: string, booking: Booking) {
      calendarEvents.set(eventId, { id: eventId, start: booking.startsAt, end: booking.endsAt, bookkitBookingId: booking.id });
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

// Plan 021: a durable hook, so its delivery rides the same outbox row (and the same D1 batch as the
// confirmation) the production stack uses for a webhook subscriber.
const hooks: BookingEventHook[] = [{
  name: 'ops',
  durable: true,
  async handler(event, booking) {
    hookOutbox.push({ event, bookingId: booking.id });
  },
}];

const runtime = defineCloudflareBookkitRuntime(config, { providers, hooks });

export default {
  // Standard modules-format signature (env/ctx unused: getWorkerEnv/getWorkerWaitUntil in
  // src/runtime-context.ts resolve both from the `cloudflare:workers` globals instead) -- kept so
  // tests/workers/webhook.test.ts can dispatch through `createExecutionContext()` +
  // `waitOnExecutionContext()` exactly like a real modules-format worker, per cloudflare:test's
  // documented integration-test pattern (this is also why the test avoids the `SELF` service
  // binding, whose waitUntil-draining has a known gap with isolatedStorage -- see
  // https://github.com/cloudflare/workers-sdk/issues/6887).
  async fetch(request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The one route this worker exists to exercise end to end (src/routes-manifest.ts
    // 'webhooksStripe' pattern) -- everything else 404s rather than growing into a second,
    // divergent copy of the Astro route table (that stays tests/integration-entry.test.ts's job).
    if (url.pathname === '/api/booking/webhooks/stripe') {
      const context = await runtime.createContext({ request });
      return handleStripeWebhook(request, context);
    }
    return new Response('Not found', { status: 404 });
  },
};
