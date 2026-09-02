import type { D1Database } from '@cloudflare/workers-types';
import type { CalEvent } from '../../../src/core/occupancy';
import type { BookingEventHook, OperationalAlert, PaymentEventParsed } from '../../../src/core/events';
import { defineCloudflareReservaRuntime, type ReservaProviders } from '../../../src/runtime';
import { pickupOptionFor, resolveService } from '../../../src/core/config';
import config from './config';

// Hand-declared since this fixture has no `wrangler types` codegen in CI; mirrors wrangler.jsonc.
// A real consumer imports the generated `Env` from worker-configuration.d.ts instead.
interface Env {
  RESERVA_DB: D1Database;
  RESERVA_TOKEN_ENC_KEY: string;
  RESERVA_OPERATOR_SECRET: string;
  // Set so the admin CSRF layer runs in its enforcing mode rather than its fail-open path.
  RESERVA_CSRF_SECRET: string;
}

const calendarEvents = new Map<string, CalEvent>();
const checkoutSessions = new Map<string, { amountTotal: number; currency: string; pickupAddress: string | null }>();

// One constant so every caller that needs the fake collected address agrees on the exact string.
export const SMOKE_TEST_PICKUP_ADDRESS = '42 Fixture Lane, Testville';

function manageUrl(token: string): string {
  return `${config.business.url}/booking/manage?token=${encodeURIComponent(token)}`;
}

export const emailOutbox: Array<{ event: string; reference: string; customerManageUrl: string; operatorManageUrl: string; sentAt: string }> = [];

// In-memory sink for the `alerts` provider, mirroring emailOutbox below.
export const alertOutbox: OperationalAlert[] = [];

// Makes one calendar create fail permanently so the e2e suite can observe abandonment.
let forceNextCalendarFailure = false;
export function armNextCalendarFailure(): void {
  forceNextCalendarFailure = true;
}

const providers: ReservaProviders = {
  payments: {
    async createCheckout(booking, checkoutConfig) {
      const sessionRef = `local_session_${booking.id}`;
      // Derives requiresAddress from the selected option's own config, not from pickupType naming.
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
      console.info('[reserva demo] refund', { paymentRef, expectedAmountMinor });
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
        // status 400 is treated as permanent, so this abandons on the first attempt.
        throw Object.assign(new Error('simulated calendar outage'), { status: 400 });
      }
      const id = `local_calendar_${booking.id}`;
      calendarEvents.set(id, {
        id,
        start: booking.startsAt,
        end: booking.endsAt,
        reservaBookingId: booking.id,
      });
      console.info('[reserva demo] calendar created', { id, bookingId: booking.id });
      return id;
    },
    async patchEvent(eventId, booking) {
      calendarEvents.set(eventId, {
        id: eventId,
        start: booking.startsAt,
        end: booking.endsAt,
        reservaBookingId: booking.id,
      });
      console.info('[reserva demo] calendar updated', { eventId, bookingId: booking.id });
    },
    async deleteEvent(eventId) {
      calendarEvents.delete(eventId);
      console.info('[reserva demo] calendar deleted', { eventId });
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
      console.info('[reserva demo] email', {
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
      console.info('[reserva demo] operational alert', alert);
    },
  },
};

// Non-durable listener: fired post-commit, never retried.
const hooks: BookingEventHook[] = [
  {
    name: 'demo-log',
    async handler(event, booking, hookContext) {
      console.info('[reserva demo] booking event', { event, id: hookContext.id, reference: booking.reference });
    },
  },
];

export default defineCloudflareReservaRuntime<Env>(config, {
  providers,
  hooks,
  secretBindings: ['RESERVA_TOKEN_ENC_KEY', 'RESERVA_OPERATOR_SECRET', 'RESERVA_CSRF_SECRET'],
  // Dev-only bypass: admits every request as an anonymous admin. Never do this in production.
  adminAuth: async () => ({ subject: '' }),
});
