import type { D1Database } from '@cloudflare/workers-types';
import { BrevoEmailProvider } from '@reservajs/astro/providers/email-brevo';
import { GoogleCalendarProvider } from '@reservajs/astro/providers/calendar-google';
import { StripeProvider } from '@reservajs/astro/providers/payments-stripe';
import { defineCloudflareBookkitRuntime, type BookkitProviders } from '@reservajs/astro/runtime';
import config from './bookkit.config';

// A packed consumer's site and scheduled Worker both instantiate this factory. Every credential
// used by reconciliation is therefore represented in the consumer's Env contract rather than
// accidentally relying on secrets attached only to the HTTP Worker.
interface Env {
  BOOKKIT_DB: D1Database;
  BOOKKIT_TOKEN_ENC_KEY: string;
  BOOKKIT_CSRF_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  BREVO_API_KEY: string;
  GOOGLE_SA_EMAIL: string;
  GOOGLE_SA_PRIVATE_KEY: string;
  GOOGLE_IMPERSONATE_EMAIL: string;
  GOOGLE_CALENDAR_ID: string;
  OPERATIONS_WEBHOOK_SECRET: string;
  OPERATIONS_ALERT_WEBHOOK_URL: string;
  OPERATIONS_ALERT_TOKEN: string;
}

function providers(env: Env): BookkitProviders {
  return {
    payments: new StripeProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      // Plan 022 (design decision 1): payment methods are the adapter's option now, not a
      // core config key — a packed consumer has to be able to reach them from this subpath.
      paymentMethods: ['card', 'mb_way'],
    }),
    calendar: new GoogleCalendarProvider({
      calendarId: env.GOOGLE_CALENDAR_ID,
      serviceAccountEmail: env.GOOGLE_SA_EMAIL,
      serviceAccountPrivateKey: env.GOOGLE_SA_PRIVATE_KEY,
      impersonateEmail: env.GOOGLE_IMPERSONATE_EMAIL,
    }),
    email: new BrevoEmailProvider({ apiKey: env.BREVO_API_KEY }),
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

export default defineCloudflareBookkitRuntime<Env>(config, {
  providers: ({ env }) => providers(env),
  secretBindings: ['BOOKKIT_TOKEN_ENC_KEY', 'BOOKKIT_CSRF_SECRET', 'OPERATIONS_WEBHOOK_SECRET'],
});
