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
      // A single meeting point implies one pickup option, so pricing carries no `pickup` column.
      pricing: [{ maxQuantity: 4, priceMinor: 2500 }],
      location: {
        meetingPoints: [{ id: 'default', label: 'Main square fountain', mapsUrl: 'https://maps.google.com/?q=Main+square' }],
      },
    },
  },
} satisfies ClientConfig;
