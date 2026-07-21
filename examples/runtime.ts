import { defineCloudflareBookkitRuntime, type BookkitProviders } from '../src/runtime';
import config from './client-config';

const providers: BookkitProviders = {
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

export default defineCloudflareBookkitRuntime(config, {
  // The runtime reads D1 and Cache bindings per request, so provider instances never cross a Worker request boundary.
  providers,
  // Secrets are read by name from env only when a handler needs them; they are not part of config or page props.
  secretBindings: ['TOURFLOW_SHARED_SECRET'],
});
