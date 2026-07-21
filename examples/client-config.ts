import type { ClientConfig } from 'bookkit';

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
    maxHoldsPerIp: 4,
  },
  locales: {
    supported: ['en', 'pt'],
    default: 'en',
  },
  payments: {
    methods: ['card', 'mb_way'],
  },
  legal: {
    termsUrl: 'https://example.test/terms',
  },
} satisfies ClientConfig;
