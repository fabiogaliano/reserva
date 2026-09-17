// A tuk-tuk tour operator: small fleet, hourly departures, three seats per vehicle, paid up front.
// The whole fleet keeps one set of opening hours, and alfama prices by formula (a base per vehicle
// plus the fleet-wide pick-up surcharge), so a party of 4-6 pays for two vehicles. The riverside
// route prices its pickup options outright instead, because +20 € for either custom leg but +30 €
// (not +40 €) for both is a curve no surcharge table expresses.
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
  // Every tour departs on this grid and must be back by 19:00; each service derives its own last
  // departure from that closing time. A service that declares `schedule` keeps its own.
  hours: [{ days: [1, 2, 3, 4, 5, 6], firstStart: '09:00', lastEnd: '19:00', intervalMin: 60 }],
  // The fleet-wide half of formula pricing: a party may take two vehicles, and the surcharge for
  // each pickup option is charged once per vehicle.
  pricing: { surcharges: { meeting_point: 0, hotel_pickup: 1500 }, maxUnits: 2 },
  services: {
    alfama: {
      // A per-locale map wherever a customer reads it; a plain string is still accepted.
      title: { en: 'Alfama Discovery', 'pt-PT': 'Descoberta de Alfama' },
      durationMin: 60,
      turnaroundMin: 15,
      // Three seats per tuk-tuk, so a party of 4 takes two of the three vehicles in `capacity.default`
      // and, under the formula below, pays 2 × (45 € + the pickup surcharge).
      occupancy: { seatsPerUnit: 3 },
      pricing: { baseMinor: 4500 },
      location: {
        meetingPoints: [{ id: 'se', label: 'Sé Cathedral', mapsUrl: 'https://maps.google.com/?q=Se+Lisboa' }],
        pickupOptions: [
          { id: 'meeting_point', label: { en: 'Meeting point', 'pt-PT': 'Ponto de encontro' }, requiresAddress: false, usesMeetingPoint: true },
          { id: 'hotel_pickup', label: { en: 'Hotel pick-up', 'pt-PT': 'Recolha no hotel' }, requiresAddress: true, usesMeetingPoint: false },
        ],
      },
    },
    riverside: {
      title: { en: 'Riverside Grand Tour', 'pt-PT': 'Grande Tour Ribeirinho' },
      durationMin: 120,
      turnaroundMin: 15,
      // Runs on Sundays too, so it declares its own rule instead of inheriting `hours`. `lastEnd`
      // is the closing time, not the last departure: the 17:00 last start is derived from it.
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
    minNoticeHours: 24,
  },
  locales: { supported: ['en', 'pt-PT'], default: 'en' },
  legal: { termsUrl: 'https://lisbontuktours.example/terms' },
} satisfies ClientConfig;
