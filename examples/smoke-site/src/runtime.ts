import type { CalEvent } from '../../../src/core/occupancy';
import type { StripeEventParsed } from '../../../src/core/events';
import { defineCloudflareBookkitRuntime, type BookkitProviders } from '../../../src/runtime';
import config from './config';

const calendarEvents = new Map<string, CalEvent>();

function manageUrl(token: string): string {
  return `${config.business.url}/booking/manage?token=${encodeURIComponent(token)}`;
}

const providers: BookkitProviders = {
  payments: {
    async createCheckout(booking) {
      const sessionId = `local_session_${booking.id}`;
      return {
        sessionId,
        url: `/booking-confirmation?session_id=${encodeURIComponent(sessionId)}`,
      };
    },
    async parseWebhook(request) {
      return await request.json() as StripeEventParsed;
    },
    async getSession(sessionId) {
      return {
        id: sessionId,
        status: 'complete',
        paymentStatus: 'paid',
        paymentIntent: `local_payment_${sessionId}`,
        customerName: 'Local Demo Customer',
        customerEmail: 'customer@example.test',
        customerPhone: '+351 910 000 000',
      };
    },
    async refund(paymentIntent) {
      console.info('[bookkit demo] refund', { paymentIntent });
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

export default defineCloudflareBookkitRuntime(config, {
  providers,
  secretBindings: ['TOURFLOW_SHARED_SECRET'],
  verifyAccess: () => true,
});
