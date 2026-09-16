import type { D1Database } from '@cloudflare/workers-types';
import type { PaymentProvider } from '@reservajs/astro/core';
import { GoogleCalendarProvider } from '@reservajs/astro/providers/calendar-google';
import { defineCloudflareReservaRuntime, type ReservaProviders } from '@reservajs/astro/runtime';
import { consoleEmailProvider } from './email-provider';

// The core-only consumer: @reservajs/astro alone, with a payment provider written from the public
// port. `stripe` is not installed anywhere in this project — if the library still reached for the
// SDK, this build could not succeed.
export interface Env {
  RESERVA_DB: D1Database;
  RESERVA_TOKEN_ENC_KEY: string;
  RESERVA_CSRF_SECRET: string;
  GOOGLE_SA_EMAIL: string;
  GOOGLE_SA_PRIVATE_KEY: string;
  GOOGLE_IMPERSONATE_EMAIL: string;
  GOOGLE_CALENDAR_ID: string;
  OPERATIONS_WEBHOOK_SECRET: string;
  OPERATIONS_ALERT_WEBHOOK_URL: string;
  OPERATIONS_ALERT_TOKEN: string;
}

const housePayments: PaymentProvider = {
  async createCheckout(booking) {
    return { url: `https://payments.example/checkout/${booking.id}`, sessionRef: `house_${booking.id}` };
  },
  async parseWebhook(request) {
    return await request.json() as Awaited<ReturnType<PaymentProvider['parseWebhook']>>;
  },
  async getSession() {
    return { status: 'complete', paymentStatus: 'paid' };
  },
  async refund(paymentRef, expectedAmountMinor) {
    return { refundRef: `house_refund_${paymentRef}`, amountMinor: expectedAmountMinor };
  },
};

function providers(env: Env): ReservaProviders {
  return {
    payments: housePayments,
    calendar: new GoogleCalendarProvider({
      calendarId: env.GOOGLE_CALENDAR_ID,
      serviceAccountEmail: env.GOOGLE_SA_EMAIL,
      serviceAccountPrivateKey: env.GOOGLE_SA_PRIVATE_KEY,
      impersonateEmail: env.GOOGLE_IMPERSONATE_EMAIL,
    }),
    email: consoleEmailProvider,
    alerts: {
      async send(alert) {
        const response = await fetch(env.OPERATIONS_ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.OPERATIONS_ALERT_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(alert),
        });
        if (!response.ok) throw new Error(`Operational alert delivery failed (${response.status})`);
      },
    },
  };
}

// No config argument: the runtime reads the validated config from `virtual:reserva/config`,
// which the integration emits from the same `reserva.config.ts` astro.config.ts passes it.
export default defineCloudflareReservaRuntime<Env>({
  providers: ({ env }) => providers(env),
});
