// A restaurant taking deposit-backed dinner reservations: pricing rows are per-party deposits
// (the balance is settled in person), and there's no `location` module since a restaurant has no
// pickup axis -- business-specific questions travel as declared `metadataFields` instead.
import type { ClientConfig } from '@reservajs/astro';

export default {
  business: {
    name: 'Tasca do Rio',
    shortCode: 'TDR',
    url: 'https://tascadorio.example',
    timezone: 'Europe/Lisbon',
    currency: 'eur',
    contact: { email: 'reservas@tascadorio.example', phone: '+351 210 000 000' },
  },
  // Covers available per seating, shared by every party booked into the same slot.
  capacity: { default: 40 },
  admin: { access: { teamDomain: 'https://tascadorio.cloudflareaccess.com', aud: '<AUD>' } },
  services: {
    dinner: {
      title: 'Dinner',
      durationMin: 90,
      turnaroundMin: 30,
      schedule: [{ days: [2, 3, 4, 5, 6], firstStart: '18:00', lastStart: '21:30', intervalMin: 30 }],
      // Breakpoints, not per-person maths: the first row covering the party size wins.
      pricing: [
        { maxQuantity: 2, priceMinor: 2000 },
        { maxQuantity: 4, priceMinor: 4000 },
        { maxQuantity: 8, priceMinor: 8000 },
      ],
      metadataFields: [
        { key: 'dietary_notes', label: 'Dietary notes or allergies', type: 'text', maxLength: 200 },
        {
          key: 'occasion',
          label: 'Occasion',
          type: 'select',
          options: [
            { value: 'none', label: 'Just dinner' },
            { value: 'birthday', label: 'Birthday' },
            { value: 'anniversary', label: 'Anniversary' },
          ],
        },
        { key: 'highchair', label: 'High chair needed', type: 'boolean' },
      ],
    },
  },
  booking: {
    minNoticeHours: 1,
    maxHorizonDays: 60,
    cancelCutoffHours: 4,
    limitedThreshold: 6,
  },
  locales: { supported: ['pt-PT', 'en'], default: 'pt-PT' },
  legal: { termsUrl: 'https://tascadorio.example/terms' },
} satisfies ClientConfig;
