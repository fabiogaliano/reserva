import type { D1Database } from '@cloudflare/workers-types';
import type { BookingEventHook } from '../../../src/core/events';
// This example lives inside the Reserva repository, so it reads the library from source; a real
// consumer imports `devProviders` from '@reservajs/astro/dev', gated on `import.meta.env.DEV`.
import { armNextCalendarFailure, devOutbox, devProviders } from '../../../src/dev/index';
import { defineCloudflareReservaRuntime } from '../../../src/runtime';

// Hand-declared since this fixture has no `wrangler types` codegen in CI; mirrors wrangler.jsonc.
// A real consumer gets `Env` globally from `wrangler types` and declares nothing.
export interface Env {
  RESERVA_DB: D1Database;
  RESERVA_TOKEN_ENC_KEY: string;
  RESERVA_OPERATOR_SECRET: string;
  // Set so the admin CSRF layer runs in its enforcing mode rather than its fail-open path.
  RESERVA_CSRF_SECRET: string;
}

// One constant so every caller that needs the fake collected address agrees on the exact string.
export const SMOKE_TEST_PICKUP_ADDRESS = '42 Fixture Lane, Testville';

// The dev-only inspection seams the e2e suite reads through /dev/*.json; the fakes themselves now
// live in the library's `./dev` entry.
export const emailOutbox = devOutbox.emails;
export const alertOutbox = devOutbox.alerts;
export { armNextCalendarFailure };

// Non-durable listener: fired post-commit, never retried.
const hooks: BookingEventHook[] = [
  {
    name: 'demo-log',
    async handler(event, booking, hookContext) {
      // `booking` is null for settings.changed, the one event with no booking behind it.
      console.info('[reserva demo] booking event', { event, id: hookContext.id, reference: booking?.reference });
    },
  },
];

// No `adminAuth`: `config.admin.access` selects Cloudflare Access, and `astro dev` output bypasses
// it automatically, so this file is identical in development and production.
export default defineCloudflareReservaRuntime<Env>({
  providers: devProviders({ pickupAddress: SMOKE_TEST_PICKUP_ADDRESS }),
  hooks,
});
