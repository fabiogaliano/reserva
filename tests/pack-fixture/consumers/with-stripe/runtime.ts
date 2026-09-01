import type { D1Database } from '@cloudflare/workers-types';
import { GoogleCalendarProvider } from '@reservajs/astro/providers/calendar-google';
import { defineCloudflareReservaRuntime, type ReservaProviders } from '@reservajs/astro/runtime';
import { stripe } from '@reservajs/stripe';
import { consoleEmailProvider } from './email-provider';
import config from './reserva.config';

// The official-adapter consumer: both packages installed, payments wired through the one exported
// factory. Every credential used by reconciliation is represented in the Env contract, so the
// scheduled Worker never relies on secrets attached only to the HTTP Worker.
interface Env {
  RESERVA_DB: D1Database;
  RESERVA_TOKEN_ENC_KEY: string;
  RESERVA_CSRF_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  GOOGLE_SA_EMAIL: string;
  GOOGLE_SA_PRIVATE_KEY: string;
  GOOGLE_IMPERSONATE_EMAIL: string;
  GOOGLE_CALENDAR_ID: string;
  OPERATIONS_WEBHOOK_SECRET: string;
  OPERATIONS_ALERT_WEBHOOK_URL: string;
  OPERATIONS_ALERT_TOKEN: string;
}

function providers(env: Env): ReservaProviders {
  return {
    payments: stripe({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      // Payment methods are the adapter's option, not a core config key — a packed consumer has
      // to be able to reach them from the factory.
      paymentMethods: ['card', 'mb_way'],
    }),
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

export default defineCloudflareReservaRuntime<Env>(config, {
  providers: ({ env }) => providers(env),
  secretBindings: ['RESERVA_TOKEN_ENC_KEY', 'RESERVA_CSRF_SECRET', 'OPERATIONS_WEBHOOK_SECRET'],
});
