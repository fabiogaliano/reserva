// A tuk-tuk tour operator: small fleet, hourly departures, three seats per vehicle, paid up front.
// The riverside route prices pickup options outright rather than as surcharges: +20 € for either
// custom leg alone, but +30 € (not +40 €) for both -- a surcharge model can't express that.
import type { ClientConfig } from '@reservajs/astro';

export default {
  business: {
    name: 'Lisbon Tuk Tours',
    shortCode: 'LTT',
    url: 'https://lisbontuktours.example',
    timezone: 'Europe/Lisbon',
    currency: 'eur',
    contact: { email: 'bookings@lisbontuktours.example', phone: '+351 210 000 000' },
  },
  capacity: { default: 3 },
  admin: { access: { teamDomain: 'https://lisbontuktours.cloudflareaccess.com', aud: '<AUD>' } },
  services: {
    alfama: {
      // A per-locale map wherever a customer reads it; a plain string is still accepted.
      title: { en: 'Alfama Discovery', 'pt-PT': 'Descoberta de Alfama' },
      durationMin: 60,
      turnaroundMin: 15,
      schedule: [{ days: [1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '17:00', intervalMin: 60 }],
      // Three seats per tuk-tuk, so a party of 4 takes two of the three vehicles in `capacity.default`.
      occupancy: { seatsPerUnit: 3 },
      // A single meeting point implies one pickup option ('meeting_point'), so pricing needs no `pickup` column.
      pricing: [{ maxQuantity: 3, priceMinor: 4500 }],
      location: {
        meetingPoints: [{ id: 'se', label: 'Sé Cathedral', mapsUrl: 'https://maps.google.com/?q=Se+Lisboa' }],
      },
    },
    riverside: {
      title: { en: 'Riverside Grand Tour', 'pt-PT': 'Grande Tour Ribeirinho' },
      durationMin: 120,
      turnaroundMin: 15,
      // `lastEnd` is the closing time, not the last departure: the 17:00 last start is derived from
      // it and follows `durationMin` automatically.
      schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastEnd: '19:00', intervalMin: 60 }],
      location: {
        meetingPoints: [
          { id: 'dock', label: 'Riverside dock', mapsUrl: 'https://maps.google.com/?q=Riverside+dock' },
          { id: 'gate', label: 'North gate', mapsUrl: 'https://maps.google.com/?q=North+gate' },
        ],
        pickupOptions: [
          { id: 'meeting_point', label: { en: 'Meeting point', 'pt-PT': 'Ponto de encontro' }, requiresAddress: false, usesMeetingPoint: true },
          { id: 'custom_dropoff', label: { en: 'Custom drop-off', 'pt-PT': 'Entrega personalizada' }, requiresAddress: true, usesMeetingPoint: true },
          { id: 'custom_pickup', label: { en: 'Custom pick-up', 'pt-PT': 'Recolha personalizada' }, requiresAddress: true, usesMeetingPoint: false },
          { id: 'custom_both', label: { en: 'Custom pick-up & drop-off', 'pt-PT': 'Recolha e entrega personalizadas' }, requiresAddress: true, usesMeetingPoint: false },
        ],
      },
      pricing: [
        { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 18000 },
        { maxQuantity: 4, pickup: 'custom_dropoff', priceMinor: 20000 },
        { maxQuantity: 4, pickup: 'custom_pickup', priceMinor: 20000 },
        { maxQuantity: 4, pickup: 'custom_both', priceMinor: 21000 },
      ],
    },
  },
  booking: {
    minNoticeHours: 2,
  },
  locales: { supported: ['en', 'pt-PT'], default: 'en' },
  legal: { termsUrl: 'https://lisbontuktours.example/terms' },
} satisfies ClientConfig;
