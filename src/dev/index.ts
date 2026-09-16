// In-memory stand-ins for every provider port, so `astro dev` boots a complete booking flow with no
// Stripe account, no calendar and no mail transport. Nothing here is durable and nothing here is
// safe in production: gate the import on `import.meta.env.DEV` so a production build tree-shakes it.

import type { Booking } from '../core/booking.js';
import type { ResolvedClientConfig } from '../core/config.js';
import { pickupOptionFor, resolveService } from '../core/config.js';
import type {
  EmailBookingEvent,
  OperationalAlert,
  PaymentEventParsed,
  SessionStatus,
} from '../core/events.js';
import type { CalEvent } from '../core/occupancy.js';
import type { ReservaResolvedRouteConfig } from '../routes-manifest.js';
import type { ReservaProviders } from '../context.js';

export interface DevEmail {
  event: EmailBookingEvent;
  reference: string;
  customerManageUrl: string;
  operatorManageUrl: string;
  sentAt: string;
}

// The one place a test (or a curious developer) reads what the fakes "sent". Module-scope so the
// arrays survive across requests within the dev server's isolate, exactly like the Maps below.
export const devOutbox: { emails: DevEmail[]; alerts: OperationalAlert[] } = { emails: [], alerts: [] };

const checkoutSessions = new Map<string, { amountTotal: number; currency: string; pickupAddress: string | null }>();
const calendarEvents = new Map<string, CalEvent>();

let forceNextCalendarFailure = false;

// Makes the next calendar create fail permanently, so a suite can observe the abandonment and
// incident path without waiting for a real provider outage.
export function armNextCalendarFailure(): void {
  forceNextCalendarFailure = true;
}

export interface DevProvidersOptions {
  // What the fake payment page "collects" — the details a real processor would hand back on the
  // confirmed session.
  customer?: { name?: string; email?: string; phone?: string };
  // Returned as the collected address for any pickup option whose config requires one.
  pickupAddress?: string;
}

const DEFAULT_CUSTOMER = { name: 'Local Demo Customer', email: 'customer@example.test', phone: '+351 910 000 000' };

function manageUrl(config: ResolvedClientConfig, routeConfig: ReservaResolvedRouteConfig | undefined, token: string): string {
  const path = routeConfig?.paths.managePage ?? '/booking/manage';
  return `${config.business.url}${path}?token=${encodeURIComponent(token)}`;
}

export function devProviders(options: DevProvidersOptions = {}): ReservaProviders {
  const customer = { ...DEFAULT_CUSTOMER, ...options.customer };
  return {
    payments: {
      async createCheckout(booking: Booking, config: ResolvedClientConfig, routePaths?: ReservaResolvedRouteConfig['paths']) {
        const sessionRef = `local_session_${booking.id}`;
        // Derived from the selected option's own config, not from how its id is spelled: ids are
        // opaque, so `requiresAddress` is the only thing that decides whether an address exists.
        const service = resolveService(config, booking.serviceSlug);
        const requiresAddress = pickupOptionFor(service, booking.pickupType)?.requiresAddress ?? false;
        checkoutSessions.set(sessionRef, {
          amountTotal: booking.priceMinor,
          currency: config.business.currency,
          pickupAddress: requiresAddress ? options.pickupAddress ?? null : null,
        });
        const confirmation = routePaths?.confirmationPage ?? '/booking-confirmation';
        return {
          sessionRef,
          url: `${confirmation}?sessionId=${encodeURIComponent(sessionRef)}`,
          // Mirrors a real processor's page deadline so the checkout response carries one; the
          // fake page itself never expires.
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        };
      },
      // No signature to verify: the dev "provider" is whatever posted the body, which is the
      // point — a suite can drive any payment event by hand.
      async parseWebhook(request: Request): Promise<PaymentEventParsed> {
        return await request.json() as PaymentEventParsed;
      },
      async getSession(sessionRef: string): Promise<SessionStatus> {
        const session = checkoutSessions.get(sessionRef);
        if (!session) return { id: sessionRef, status: 'open', paymentStatus: 'unpaid' };
        return {
          id: sessionRef,
          status: 'complete',
          paymentStatus: 'paid',
          amountTotal: session.amountTotal,
          currency: session.currency,
          paymentRef: `local_payment_${sessionRef}`,
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          pickupAddress: session.pickupAddress,
        };
      },
      async refund(paymentRef: string, expectedAmountMinor: number) {
        console.info('[reserva dev] refund', { paymentRef, expectedAmountMinor });
        return { refundRef: `local_refund_${paymentRef}`, amountMinor: expectedAmountMinor };
      },
      async cancelPayment(paymentRef: string) {
        console.info('[reserva dev] cancel payment', { paymentRef });
      },
    },
    calendar: {
      async listEvents() {
        return [...calendarEvents.values()];
      },
      async createEvent(booking: Booking) {
        if (forceNextCalendarFailure) {
          forceNextCalendarFailure = false;
          // status 400 is treated as permanent, so this abandons on the first attempt.
          throw Object.assign(new Error('simulated calendar outage'), { status: 400 });
        }
        const id = `local_calendar_${booking.id}`;
        calendarEvents.set(id, { id, start: booking.startsAt, end: booking.endsAt, reservaBookingId: booking.id });
        console.info('[reserva dev] calendar created', { id, bookingId: booking.id });
        return id;
      },
      async patchEvent(eventId: string, booking: Booking) {
        calendarEvents.set(eventId, { id: eventId, start: booking.startsAt, end: booking.endsAt, reservaBookingId: booking.id });
        console.info('[reserva dev] calendar updated', { eventId, bookingId: booking.id });
      },
      async deleteEvent(eventId: string) {
        calendarEvents.delete(eventId);
        console.info('[reserva dev] calendar deleted', { eventId });
      },
    },
    email: {
      async send(event: EmailBookingEvent, booking: Booking, config: ResolvedClientConfig, routeConfig?: ReservaResolvedRouteConfig) {
        const entry: DevEmail = {
          event,
          reference: booking.reference,
          customerManageUrl: manageUrl(config, routeConfig, booking.cancelToken),
          operatorManageUrl: manageUrl(config, routeConfig, booking.operatorToken),
          sentAt: new Date().toISOString(),
        };
        devOutbox.emails.push(entry);
        // The manage links are the whole point of logging these: they are the only way to reach a
        // booking's cancel/reschedule page when no mail actually leaves the machine.
        console.info('[reserva dev] email', entry);
      },
      async sendMessage(message) {
        console.info('[reserva dev] message', message);
      },
    },
    alerts: {
      async send(alert: OperationalAlert) {
        devOutbox.alerts.push(alert);
        console.warn('[reserva dev] operational alert', alert);
      },
    },
  };
}
