// Minimal but fully valid ClientConfig, imported through the package's real "." and "./core"
// exports subpaths (not a relative ../../src import) — this fixture exists to prove those subpaths
// resolve and typecheck as an installed consumer sees them (plan 010).
import type { ClientConfig } from '@reservajs/astro';
import type { ServiceConfig } from '@reservajs/astro/core';

const demoTour: ServiceConfig = {
  durationMin: 60,
  turnaroundMin: 15,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '17:00', intervalMin: 60 }],
  // Config validation requires a rule for every declared pickup option at every quantity-count up
  // to maxQuantity.
  pricing: [
    { maxQuantity: 4, pickup: 'default', priceMinor: 5000 },
    { maxQuantity: 4, pickup: 'custom', priceMinor: 6000 },
  ],
  location: {
    meetingPoints: [{ id: 'default', label: 'Fixture meeting point', mapsUrl: 'https://example.test/map' }],
    pickupOptions: [
      { id: 'default', requiresAddress: false, usesMeetingPoint: true },
      { id: 'custom', requiresAddress: true, usesMeetingPoint: false },
    ],
  },
};

export default {
  business: {
    name: 'Pack Fixture Tours',
    shortCode: 'PFT',
    url: 'https://fixture.example.test',
    timezone: 'UTC',
    currency: 'eur',
    contact: { email: 'owner@example.test', phone: '+10000000000' },
  },
  capacity: { default: 4 },
  admin: { access: { teamDomain: 'https://team.cloudflareaccess.com', aud: 'fixture-aud' } },
  services: { demo: demoTour },
  booking: {
    minNoticeHours: 0,
    maxHorizonDays: 30,
    holdMinutes: 35,
    cancelCutoffHours: 0,
    reschedule: { enabled: true, cutoffHours: 0 },
    limitedThreshold: 2,
    calendarMaxStaleSeconds: 900,
  },
  locales: { supported: ['en'], default: 'en' },
  // Plan 021: a packed consumer declares outbound webhooks in config; the secret is read from the
  // binding named here, which the runtime must also list in secretBindings.
  webhooks: [{ name: 'operations', url: 'https://ops.example.test/bookkit', secretBinding: 'OPERATIONS_WEBHOOK_SECRET' }],
  legal: { termsUrl: 'https://fixture.example.test/terms' },
} satisfies ClientConfig;
