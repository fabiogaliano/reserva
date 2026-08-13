import baseConfig from '../../client-config';
import type { ClientConfig } from '../../../src/core/config';

// Plan 017 (design decision 5): the base tour declares the meetingPoint shorthand; destructuring
// it out here (rather than spreading it and then setting `meetingPoint: undefined`, which
// `exactOptionalPropertyTypes` rejects — undefined isn't assignable to the shorthand's required
// `{ label, mapsUrl }`) is how oldTownBase below swaps it for the meetingPoints array without
// declaring both (exactly-one-of, see core/config.ts validateTour).
const { meetingPoint: _oldTownMeetingPoint, ...oldTownBase } = baseConfig.tours.oldTown;

export default {
  ...baseConfig,
  business: {
    ...baseConfig.business,
    url: 'http://localhost:4321',
    timezone: 'UTC',
  },
  tours: {
    oldTown: {
      ...oldTownBase,
      // Two free meeting points, so the e2e suite has a real multi-point tour to book the second
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
