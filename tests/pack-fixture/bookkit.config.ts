// Minimal but fully valid ClientConfig, imported through the package's real "." and "./core"
// exports subpaths (not a relative ../../src import) — this fixture exists to prove those subpaths
// resolve and typecheck as an installed consumer sees them (plan 010).
import type { ClientConfig } from 'bookkit';
import type { TourConfig } from 'bookkit/core';

const demoTour: TourConfig = {
  durationMin: 60,
  turnaroundMin: 15,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '17:00', intervalMin: 60 }],
  // Config validation requires a rule for every pickup type at every people-count up to maxPeople.
  pricing: [
    { maxPeople: 4, pickup: 'default', priceCents: 5000 },
    { maxPeople: 4, pickup: 'custom', priceCents: 6000 },
  ],
  meetingPoint: { label: 'Fixture meeting point', mapsUrl: 'https://example.test/map' },
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
  fleet: { defaultCapacity: 4 },
  admin: { accessTeamDomain: 'https://team.cloudflareaccess.com', accessAud: 'fixture-aud' },
  tours: { demo: demoTour },
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
  payments: { methods: ['card'] },
  legal: { termsUrl: 'https://fixture.example.test/terms' },
} satisfies ClientConfig;
