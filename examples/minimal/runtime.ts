import type { D1Database } from '@cloudflare/workers-types';
import { defineCloudflareReservaRuntime, type ReservaProviders } from '../../src/runtime';
import config from './client-config';

// Stand-in for the `Env` interface `wrangler types` generates from wrangler.jsonc into
// worker-configuration.d.ts (see README "Typed environment bindings"). A real consumer imports
// that generated `Env` instead of hand-declaring it.
interface Env {
  RESERVA_DB: D1Database;
  RESERVA_OPERATOR_SECRET: string;
}

const providers: ReservaProviders = {
  payments: {
    async createCheckout() {
      throw new Error('Provide the application Stripe adapter before accepting bookings');
    },
    async parseWebhook() {
      throw new Error('Provide the application Stripe adapter before accepting webhooks');
    },
    async getSession() {
      throw new Error('Provide the application Stripe adapter before checking status');
    },
    async refund() {
      throw new Error('Provide the application Stripe adapter before issuing refunds');
    },
  },
};

export default defineCloudflareReservaRuntime<Env>(config, {
  // The runtime reads D1 and Cache bindings per request, so provider instances never cross a Worker request boundary.
  providers,
  // Secrets are read by name from env only when a handler needs them; they are not part of config or page props.
  // The <Env> type argument constrains this list to keyof Env, catching a typo'd binding name at compile time.
  secretBindings: ['RESERVA_OPERATOR_SECRET'],
});
