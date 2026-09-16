import baseConfig from '../../minimal/client-config';
import type { ClientConfig } from '../../../src/core/config';

export default {
  ...baseConfig,
  business: {
    ...baseConfig.business,
    url: 'http://localhost:4321',
    timezone: 'UTC',
  },
  // Declared directly rather than inherited: the minimal example collapses to the schema's
  // implied defaults, but this fixture deliberately exercises every optional module.
  admin: {
    locale: 'en',
    // Placeholders: Access only gates the deployed hostname, and `astro dev` bypasses the gate,
    // so the smoke site never needs a hand-written dev `adminAuth`.
    access: { teamDomain: 'https://smoke-site.cloudflareaccess.com', aud: 'smoke-site-placeholder-aud' },
  },
  services: {
    oldTown: {
      // A per-locale map, the shape every customer-facing label takes.
      title: { en: 'Old Town Walk', 'pt-PT': 'Passeio na Cidade Velha' },
      durationMin: 60,
      turnaroundMin: 15,
      schedule: [{
        days: [0, 1, 2, 3, 4, 5, 6],
        firstStart: '09:00',
        lastStart: '17:00',
        intervalMin: 60,
      }],
      pricing: [
        { maxQuantity: 4, pickup: 'default', priceMinor: 2500 },
        { maxQuantity: 4, pickup: 'custom', priceMinor: 3500 },
      ],
      location: {
        meetingPoints: [
          { id: 'fountain', label: 'Main square fountain', mapsUrl: 'https://maps.google.com/?q=Main+square' },
          { id: 'station', label: 'Riverside dock', mapsUrl: 'https://maps.google.com/?q=Riverside+dock' },
        ],
        pickupOptions: [
          { id: 'default', label: { en: 'Meeting point', 'pt-PT': 'Ponto de encontro' }, requiresAddress: false, usesMeetingPoint: true },
          { id: 'custom', label: { en: 'Custom pickup', 'pt-PT': 'Recolha personalizada' }, hint: { en: 'We pick you up at your address', 'pt-PT': 'Vamos buscá-lo à sua morada' }, requiresAddress: true, usesMeetingPoint: false },
        ],
      },
    },
    // Pricing is deliberately non-additive: +20 for either custom leg, but +30 for both.
    mazeRiverside: {
      title: { en: 'Maze & Riverside', 'pt-PT': 'Labirinto e Ribeirinha' },
      durationMin: 120,
      turnaroundMin: 15,
      schedule: [{
        days: [0, 1, 2, 3, 4, 5, 6],
        firstStart: '09:00',
        lastStart: '17:00',
        intervalMin: 60,
      }],
      location: {
        meetingPoints: [
          { id: 'dock', label: 'Riverside dock', mapsUrl: 'https://maps.google.com/?q=Riverside+dock' },
          { id: 'gate', label: 'Maze north gate', mapsUrl: 'https://maps.google.com/?q=Maze+north+gate' },
        ],
        pickupOptions: [
          { id: 'meeting_point', label: 'Meeting point', requiresAddress: false, usesMeetingPoint: true },
          { id: 'custom_dropoff', label: 'Custom drop-off', requiresAddress: true, usesMeetingPoint: true },
          { id: 'custom_pickup', label: 'Custom pick-up', requiresAddress: true, usesMeetingPoint: false },
          { id: 'custom_both', label: 'Custom pick-up & drop-off', requiresAddress: true, usesMeetingPoint: false },
        ],
      },
      pricing: [
        { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 18000 },
        { maxQuantity: 4, pickup: 'custom_dropoff', priceMinor: 20000 },
        { maxQuantity: 4, pickup: 'custom_pickup', priceMinor: 20000 },
        { maxQuantity: 4, pickup: 'custom_both', priceMinor: 21000 },
      ],
    },
    riverCruise: {
      title: { en: 'River Cruise', 'pt-PT': 'Cruzeiro no Rio' },
      durationMin: 90,
      turnaroundMin: 15,
      schedule: [{
        days: [0, 1, 2, 3, 4, 5, 6],
        firstStart: '10:00',
        lastStart: '16:00',
        intervalMin: 60,
      }],
      pricing: [{ maxQuantity: 6, priceMinor: 4200 }],
      metadataFields: [
        { key: 'dietary_notes', label: 'Dietary notes', type: 'text', required: true, maxLength: 200 },
        {
          key: 'seat_pref',
          label: 'Seat preference',
          type: 'select',
          options: [
            { value: 'window', label: 'Window seat' },
            { value: 'aisle', label: 'Aisle seat' },
          ],
        },
      ],
    },
  },
  booking: {
    minNoticeHours: 0,
    maxHorizonDays: 365,
    cancelCutoffHours: 0,
    reschedule: {
      enabled: true,
      cutoffHours: 0,
    },
    maxHoldsPerIp: 20,
  },
  locales: { supported: ['pt-PT', 'en'], default: 'en' },
  legal: { termsUrl: 'https://example.test/terms' },
} satisfies ClientConfig;
