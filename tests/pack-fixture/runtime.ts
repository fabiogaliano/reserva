// Consumer-shaped runtime module, wired through `bookkit/runtime`, `bookkit/core`, and
// `bookkit/providers/email-none` — narrow provider subpaths, per the README's own guidance against
// the `bookkit/providers` barrel. Never actually invoked (the fixture only builds, it never runs a
// server or handles a request — see plan 010's scope guard), so provider bodies just need to
// typecheck against the real published interfaces, not behave correctly.
import type { D1Database } from '@cloudflare/workers-types';
import type { PaymentProvider, StripeEventParsed } from 'bookkit/core';
import { createNoopEmailProvider } from 'bookkit/providers/email-none';
import { defineCloudflareBookkitRuntime, type BookkitProviders } from 'bookkit/runtime';
import config from './bookkit.config';

// Hand-declared, like examples/smoke-site/src/runtime.ts: this fixture has no `wrangler types`
// codegen step of its own.
interface Env {
  BOOKKIT_DB: D1Database;
  BOOKKIT_TOKEN_ENC_KEY: string;
}

const payments: PaymentProvider = {
  async createCheckout(booking) {
    return { sessionId: `fixture_${booking.id}`, url: '/booking-confirmation' };
  },
  async parseWebhook(request) {
    return await request.json() as StripeEventParsed;
  },
  async getSession(sessionId) {
    return { id: sessionId, status: 'open', paymentStatus: 'unpaid' };
  },
  async refund() {
    return { refundId: 'fixture_refund', amountCents: 0 };
  },
};

const providers: BookkitProviders = {
  payments,
  email: createNoopEmailProvider(),
};

export default defineCloudflareBookkitRuntime<Env>(config, {
  providers,
  secretBindings: ['BOOKKIT_TOKEN_ENC_KEY'],
});
