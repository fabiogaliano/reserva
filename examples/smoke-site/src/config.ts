import baseConfig from '../../client-config';
import type { ClientConfig } from '../../../src/core/config';

// Plan 017 (design decision 5): the base service declares the meetingPoint shorthand; destructuring
// it out here (rather than spreading it and then setting `meetingPoint: undefined`, which
// `exactOptionalPropertyTypes` rejects — undefined isn't assignable to the shorthand's required
// `{ label, mapsUrl }`) is how oldTownBase below swaps it for the meetingPoints array without
// declaring both (exactly-one-of, see core/config.ts validateService).
const { meetingPoint: _oldTownMeetingPoint, ...oldTownBase } = baseConfig.services.oldTown;

export default {
  ...baseConfig,
  business: {
    ...baseConfig.business,
    url: 'http://localhost:4321',
    timezone: 'UTC',
  },
  services: {
    oldTown: {
      ...oldTownBase,
      // Two free meeting points, so the e2e suite has a real multi-point service to book the second
      // point through.
      meetingPoints: [
        { id: 'fountain', label: 'Main square fountain', mapsUrl: 'https://maps.google.com/?q=Main+square' },
        { id: 'station', label: 'Riverside dock', mapsUrl: 'https://maps.google.com/?q=Riverside+dock' },
      ],
      schedule: [{
        days: [0, 1, 2, 3, 4, 5, 6],
        firstStart: '09:00',
        lastStart: '17:00',
        intervalMin: 60,
      }],
    },
    // Plan 018 (design decisions 1-3, 9): shaped after the actual request this plan generalizes
    // for — Maze Riverside 2h, priced 180/200/200/210 € (non-additive: +20 for either custom leg,
    // but +30 for both — see README "Config" for why that rules out a surcharge model).
    //
    // Plan 019 (design decision 5): two meeting points (not one), so this same fixture also
    // covers the usesMeetingPoint axis (custom_dropoff picks a second point; custom_pickup/
    // custom_both hide the group) instead of isolating it to oldTown — the two axes' options are
    // otherwise never exercised together in a browser test.
    mazeRiverside: {
      durationMin: 120,
      turnaroundMin: 15,
      schedule: [{
        days: [0, 1, 2, 3, 4, 5, 6],
        firstStart: '09:00',
        lastStart: '17:00',
        intervalMin: 60,
      }],
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
      pricing: [
        { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 18000 },
        { maxQuantity: 4, pickup: 'custom_dropoff', priceMinor: 20000 },
        { maxQuantity: 4, pickup: 'custom_pickup', priceMinor: 20000 },
        { maxQuantity: 4, pickup: 'custom_both', priceMinor: 21000 },
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
