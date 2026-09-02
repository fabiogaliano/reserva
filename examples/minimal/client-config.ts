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
  capacity: {
    default: 3,
  },
  admin: {
    access: {
      teamDomain: 'https://example.cloudflareaccess.com',
      aud: 'example-reserva',
    },
    locale: 'en',
  },
  services: {
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
        { maxQuantity: 4, pickup: 'default', priceMinor: 2500 },
        { maxQuantity: 4, pickup: 'custom', priceMinor: 3500 },
      ],
      location: {
        meetingPoints: [{ id: 'default', label: 'Main square fountain', mapsUrl: 'https://maps.google.com/?q=Main+square' }],
        pickupOptions: [
          { id: 'default', requiresAddress: false, usesMeetingPoint: true },
          { id: 'custom', requiresAddress: true, usesMeetingPoint: false },
        ],
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
    default: 'en',
  },
  legal: {
    termsUrl: 'https://example.test/terms',
  },
} satisfies ClientConfig;
