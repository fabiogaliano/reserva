import type { ClientConfig } from '@reservajs/astro';

export default {
  business: {
    name: 'Example City Tours',
    shortCode: 'ECT',
    url: 'https://example.test',
    timezone: 'Europe/Lisbon',
    currency: 'eur',
    contact: {
      email: 'bookings@example.test',
      phone: '+351 210 000 000',
      whatsapp: '+351 910 000 000',
    },
  },
  fleet: {
    defaultCapacity: 3,
  },
  admin: {
    accessTeamDomain: 'https://example.cloudflareaccess.com',
    accessAud: 'example-bookkit',
    locale: 'pt-PT',
  },
  tours: {
    oldTown: {
      durationMin: 60,
      turnaroundMin: 15,
      schedule: [
        {
          days: [1, 2, 3, 4, 5, 6],
          firstStart: '09:00',
          lastStart: '17:00',
          intervalMin: 60,
        },
      ],
      pricing: [
        { maxPeople: 4, pickup: 'default', priceCents: 2500 },
        { maxPeople: 4, pickup: 'custom', priceCents: 3500 },
      ],
      // Single-point shorthand. A tour with more than one free meeting point (for example, two
      // pickup spots at the same price) declares the array form instead — exactly one of the two
      // is allowed, never both:
      //   meetingPoints: [
      //     { id: 'fountain', label: 'Main square fountain', mapsUrl: 'https://maps.google.com/?q=Main+square' },
      //     { id: 'station', label: 'Central station', mapsUrl: 'https://maps.google.com/?q=Central+station' },
      //   ],
      // The customer's choice travels as `meetingPointId` on the checkout body (see README —
      // "Injected routes"); see examples/smoke-site/src/config.ts for a tour actually using it.
      meetingPoint: {
        label: 'Main square fountain',
        mapsUrl: 'https://maps.google.com/?q=Main+square',
      },
    },
  },
  booking: {
    minNoticeHours: 2,
    maxHorizonDays: 90,
    holdMinutes: 35,
    cancelCutoffHours: 24,
    reschedule: {
      enabled: true,
      cutoffHours: 24,
    },
    limitedThreshold: 2,
    calendarMaxStaleSeconds: 15 * 60,
    maxHoldsPerIp: 4,
  },
  locales: {
    supported: ['pt-PT', 'en'],
    default: 'pt-PT',
  },
  payments: {
    methods: ['card', 'mb_way'],
  },
  legal: {
    termsUrl: 'https://example.test/terms',
  },
} satisfies ClientConfig;
