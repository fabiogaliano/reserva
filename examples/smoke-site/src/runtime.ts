import type { D1Database } from '@cloudflare/workers-types';
import type { CalEvent } from '../../../src/core/occupancy';
import type { StripeEventParsed } from '../../../src/core/events';
import { defineCloudflareBookkitRuntime, type BookkitProviders } from '../../../src/runtime';
import config from './config';

// Hand-declared because this fixture has no real `wrangler types` codegen in CI; it mirrors the
// bindings in wrangler.jsonc. A real consumer runs `wrangler types` (see README) and imports the
// generated `Env` from worker-configuration.d.ts instead of declaring it by hand.
interface Env {
  BOOKKIT_DB: D1Database;
  BOOKKIT_TOKEN_ENC_KEY: string;
  TOURFLOW_SHARED_SECRET: string;
}

const calendarEvents = new Map<string, CalEvent>();
const checkoutSessions = new Map<string, { amountTotal: number; currency: string }>();

function manageUrl(token: string): string {
  return `${config.business.url}/booking/manage?token=${encodeURIComponent(token)}`;
}

export const emailOutbox: Array<{ event: string; reference: string; customerManageUrl: string; operatorManageUrl: string; sentAt: string }> = [];

const providers: BookkitProviders = {
  payments: {
    async createCheckout(booking) {
      const sessionId = `local_session_${booking.id}`;
      checkoutSessions.set(sessionId, { amountTotal: booking.priceCents, currency: config.business.currency });
      return {
        sessionId,
        url: `/booking-confirmation?session_id=${encodeURIComponent(sessionId)}`,
      };
    },
    async parseWebhook(request) {
      return await request.json() as StripeEventParsed;
    },
    async getSession(sessionId) {
      const session = checkoutSessions.get(sessionId);
      if (!session) return { id: sessionId, status: 'open', paymentStatus: 'unpaid' };
      return {
        id: sessionId,
        status: 'complete',
        paymentStatus: 'paid',
        amountTotal: session.amountTotal,
        currency: session.currency,
        paymentIntent: `local_payment_${sessionId}`,
        customerName: 'Local Demo Customer',
        customerEmail: 'customer@example.test',
        customerPhone: '+351 910 000 000',
      };
    },
    async refund(paymentIntent) {
      console.info('[bookkit demo] refund', { paymentIntent });
      return { refundId: `local_refund_${paymentIntent}`, amountCents: 0 };
    },
  },
  calendar: {
    async listEvents() {
      return [...calendarEvents.values()];
    },
    async createEvent(booking) {
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
  ops: {
    async push(event, booking) {
      console.info('[bookkit demo] ops event', { event, reference: booking.reference });
    },
  },
  analytics: {
    async track(event, booking) {
      console.info('[bookkit demo] analytics event', { event, reference: booking.reference });
    },
  },
};

export default defineCloudflareBookkitRuntime<Env>(config, {
  providers,
  secretBindings: ['BOOKKIT_TOKEN_ENC_KEY', 'TOURFLOW_SHARED_SECRET'],
  verifyAccess: () => true,
});
