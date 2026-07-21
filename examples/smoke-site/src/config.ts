import baseConfig from '../../client-config';
import type { ClientConfig } from '../../../src/core/config';

export default {
  ...baseConfig,
  business: {
    ...baseConfig.business,
    url: 'http://localhost:4321',
    timezone: 'UTC',
  },
  tours: {
    oldTown: {
      ...baseConfig.tours.oldTown,
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
