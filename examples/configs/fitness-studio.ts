// A small fitness studio selling spots in scheduled group classes: fixed class times, a shared
// per-class capacity, per-person prices written as quantity breakpoints (one booking can bring
// friends). No location module and no metadata: the minimal shape most class businesses need.
import type { ClientConfig } from '@reservajs/astro';

export default {
  business: {
    name: 'North Yoga Studio',
    shortCode: 'NYS',
    url: 'https://northyoga.example',
    timezone: 'Europe/Lisbon',
    currency: 'eur',
    contact: { email: 'hello@northyoga.example', phone: '+351 210 000 000' },
  },
  capacity: { default: 12 },
  admin: { access: { teamDomain: 'https://northyoga.cloudflareaccess.com', aud: '<AUD>' } },
  services: {
    vinyasa: {
      title: 'Vinyasa Flow',
      durationMin: 60,
      turnaroundMin: 0,
      schedule: [
        { days: [1, 2, 3, 4, 5], firstStart: '07:00', lastStart: '09:00', intervalMin: 60 },
        { days: [1, 2, 3, 4, 5], firstStart: '18:00', lastStart: '20:00', intervalMin: 60 },
      ],
      // 15 € per person, expressed as breakpoints: the first row covering the quantity wins.
      pricing: [
        { maxQuantity: 1, priceMinor: 1500 },
        { maxQuantity: 2, priceMinor: 3000 },
        { maxQuantity: 3, priceMinor: 4500 },
        { maxQuantity: 4, priceMinor: 6000 },
      ],
    },
  },
  booking: {
    minNoticeHours: 1,
    maxHorizonDays: 30,
    holdMinutes: 35,
    cancelCutoffHours: 12,
    reschedule: { enabled: true, cutoffHours: 12 },
    limitedThreshold: 3,
    calendarMaxStaleSeconds: 900,
  },
  locales: { supported: ['en'], default: 'en' },
  legal: { termsUrl: 'https://northyoga.example/terms' },
} satisfies ClientConfig;
