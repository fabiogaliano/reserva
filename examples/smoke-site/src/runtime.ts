import type { D1Database } from '@cloudflare/workers-types';
import type { CalEvent } from '../../../src/core/occupancy';
import type { BookingEventHook, OperationalAlert, PaymentEventParsed } from '../../../src/core/events';
import { defineCloudflareBookkitRuntime, type BookkitProviders } from '../../../src/runtime';
import { pickupOptionFor, resolveService } from '../../../src/core/config';
import config from './config';

// Hand-declared because this fixture has no real `wrangler types` codegen in CI; it mirrors the
// bindings in wrangler.jsonc. A real consumer runs `wrangler types` (see README) and imports the
// generated `Env` from worker-configuration.d.ts instead of declaring it by hand.
interface Env {
  BOOKKIT_DB: D1Database;
  BOOKKIT_TOKEN_ENC_KEY: string;
  BOOKKIT_OPERATOR_SECRET: string;
  // Plan 009: configured so the e2e suite exercises the admin CSRF layer (src/admin-csrf.ts) the
  // way the README recommends for production, instead of its fail-open "no secret configured" path.
  BOOKKIT_CSRF_SECRET: string;
}

const calendarEvents = new Map<string, CalEvent>();
const checkoutSessions = new Map<string, { amountTotal: number; currency: string; pickupAddress: string | null }>();

// Plan 019 (design decision 4): the deterministic address any real Stripe-hosted address
// collection would produce for this fixture's test customer — kept as one constant so both the
// e2e suite and this fake session state agree on the exact string.
export const SMOKE_TEST_PICKUP_ADDRESS = '42 Fixture Lane, Testville';

function manageUrl(token: string): string {
  return `${config.business.url}/booking/manage?token=${encodeURIComponent(token)}`;
}

export const emailOutbox: Array<{ event: string; reference: string; customerManageUrl: string; operatorManageUrl: string; sentAt: string }> = [];

// Plan 020 (design decisions 10/11, step 8): the independent operator alert sink, captured
// in-memory the same way emailOutbox captures the confirmation-email provider above — proves the
// scheduled reconciler's alert-drain call actually reaches a configured `BookkitProviders.alerts`
// and delivers exactly the seven-field `OperationalAlert` shape, no more, no less.
export const alertOutbox: OperationalAlert[] = [];

// Plan 020 (step 8, e2e coverage): armed by the dev-only /dev/force-calendar-failure.json route
// (examples/smoke-site/src/pages/dev/) before the e2e suite creates a booking, so exactly the
// booking's first calendar_create attempt fails — permanently (a 400-shaped error, see
// src/provider-failure.ts's isRetryableStatus), so src/confirmation.ts's classifyAttemptOutcome
// abandons it on that first attempt rather than making the test wait out the real ten-minute
// delayed-incident threshold. Consumed (reset to false) on the throw, so it never affects any
// booking after the one it was armed for.
let forceNextCalendarFailure = false;
export function armNextCalendarFailure(): void {
  forceNextCalendarFailure = true;
}

const providers: BookkitProviders = {
  payments: {
    async createCheckout(booking, checkoutConfig) {
      const sessionRef = `local_session_${booking.id}`;
      // Plan 019 (design decision 4): derives requiresAddress from the booking's own selected
      // option (via the service config), not from pickupType naming — a fake Stripe address
      // collection step only ever runs for an option the service itself declares as requiring one,
      // same as the real custom_fields gate (src/providers/stripe.ts).
      const service = resolveService(checkoutConfig, booking.serviceSlug);
      const requiresAddress = pickupOptionFor(service, booking.pickupType)?.requiresAddress ?? false;
      checkoutSessions.set(sessionRef, {
        amountTotal: booking.priceMinor,
        currency: checkoutConfig.business.currency,
        pickupAddress: requiresAddress ? SMOKE_TEST_PICKUP_ADDRESS : null,
      });
      return {
        sessionRef,
        url: `/booking-confirmation?session_id=${encodeURIComponent(sessionRef)}`,
      };
    },
    async parseWebhook(request) {
      return await request.json() as PaymentEventParsed;
    },
    async getSession(sessionRef) {
      const session = checkoutSessions.get(sessionRef);
      if (!session) return { id: sessionRef, status: 'open', paymentStatus: 'unpaid' };
      return {
        id: sessionRef,
        status: 'complete',
        paymentStatus: 'paid',
        amountTotal: session.amountTotal,
        currency: session.currency,
        paymentRef: `local_payment_${sessionRef}`,
        customerName: 'Local Demo Customer',
        customerEmail: 'customer@example.test',
        customerPhone: '+351 910 000 000',
        pickupAddress: session.pickupAddress,
      };
    },
    async refund(paymentRef, expectedAmountMinor) {
      console.info('[bookkit demo] refund', { paymentRef, expectedAmountMinor });
      return { refundRef: `local_refund_${paymentRef}`, amountMinor: expectedAmountMinor };
    },
  },
  calendar: {
    async listEvents() {
      return [...calendarEvents.values()];
    },
    async createEvent(booking) {
      if (forceNextCalendarFailure) {
        forceNextCalendarFailure = false;
        // status 400 -> classifyProviderError/isRetryableStatus treats this as permanent, so the
        // first attempt itself abandons (see this file's armNextCalendarFailure doc comment).
        throw Object.assign(new Error('simulated calendar outage'), { status: 400 });
      }
      const id = `local_calendar_${booking.id}`;
      calendarEvents.set(id, {
        id,
        start: booking.startsAt,
        end: booking.endsAt,
        bookkitBookingId: booking.id,
      });
      console.info('[bookkit demo] calendar created', { id, bookingId: booking.id });
      return id;
    },
    async patchEvent(eventId, booking) {
      calendarEvents.set(eventId, {
        id: eventId,
        start: booking.startsAt,
        end: booking.endsAt,
        bookkitBookingId: booking.id,
      });
      console.info('[bookkit demo] calendar updated', { eventId, bookingId: booking.id });
    },
    async deleteEvent(eventId) {
      calendarEvents.delete(eventId);
      console.info('[bookkit demo] calendar deleted', { eventId });
    },
  },
  email: {
    async send(event, booking) {
      emailOutbox.push({
        event,
        reference: booking.reference,
        customerManageUrl: manageUrl(booking.cancelToken),
        operatorManageUrl: manageUrl(booking.operatorToken),
        sentAt: new Date().toISOString(),
      });
      console.info('[bookkit demo] email', {
        event,
        reference: booking.reference,
        customerManageUrl: manageUrl(booking.cancelToken),
        operatorManageUrl: manageUrl(booking.operatorToken),
      });
    },
  },
  alerts: {
    async send(alert) {
      alertOutbox.push(alert);
      console.info('[bookkit demo] operational alert', alert);
    },
  },
};

// Plan 021: what the retired ops/analytics provider sinks became — an in-process listener on the
// booking-event catalog. Non-durable (the default): fired post-commit, never retried.
const hooks: BookingEventHook[] = [
  {
    name: 'demo-log',
    async handler(event, booking, hookContext) {
      console.info('[bookkit demo] booking event', { event, id: hookContext.id, reference: booking.reference });
    },
  },
];

export default defineCloudflareBookkitRuntime<Env>(config, {
  providers,
  hooks,
  secretBindings: ['BOOKKIT_TOKEN_ENC_KEY', 'BOOKKIT_OPERATOR_SECRET', 'BOOKKIT_CSRF_SECRET'],
  // Plan 025: the local demo's custom admin auth strategy — config declares no `admin.access`
  // (Access cannot protect `localhost`), so this unconditionally admits every request as an
  // anonymous admin. A real deployment must not do this; see README "Admin access and booking
  // tokens" for the documented dev-only-bypass pattern this stands in for here.
  adminAuth: async () => ({ subject: '' }),
});
