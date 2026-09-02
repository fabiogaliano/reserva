import baseConfig from '../../minimal/client-config';
import type { ClientConfig } from '../../../src/core/config';

export default {
  ...baseConfig,
  business: {
    ...baseConfig.business,
    url: 'http://localhost:4321',
    timezone: 'UTC',
  },
  admin: { locale: baseConfig.admin.locale },
  services: {
    oldTown: {
      ...baseConfig.services.oldTown,
      location: {
        meetingPoints: [
          { id: 'fountain', label: 'Main square fountain', mapsUrl: 'https://maps.google.com/?q=Main+square' },
          { id: 'station', label: 'Riverside dock', mapsUrl: 'https://maps.google.com/?q=Riverside+dock' },
        ],
        pickupOptions: baseConfig.services.oldTown.location.pickupOptions,
      },
      schedule: [{
        days: [0, 1, 2, 3, 4, 5, 6],
        firstStart: '09:00',
        lastStart: '17:00',
        intervalMin: 60,
      }],
    },
    // Pricing is deliberately non-additive: +20 for either custom leg, but +30 for both.
    mazeRiverside: {
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
    ...baseConfig.booking,
    minNoticeHours: 0,
    maxHorizonDays: 365,
    cancelCutoffHours: 0,
    reschedule: {
      enabled: true,
      cutoffHours: 0,
    },
    maxHoldsPerIp: 20,
  },
} satisfies ClientConfig;
