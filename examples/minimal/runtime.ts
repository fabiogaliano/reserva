import type { D1Database } from '@cloudflare/workers-types';
import { defineCloudflareReservaRuntime, type ReservaProviders } from '../../src/runtime';

// Stand-in for the `Env` interface `wrangler types` generates from wrangler.jsonc. A real consumer
// has it in scope globally (see README "Typed environment bindings") and declares nothing here.
// The booking config is not imported either: it reaches the runtime through `virtual:reserva/config`.
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

export default defineCloudflareReservaRuntime<Env>({
  // The runtime reads D1 and Cache bindings per request, so provider instances never cross a Worker request boundary.
  providers,
});
