import { describe, expect, it } from 'vitest';
import { generateSlots, scheduleForDate } from '../src/core/slots';
import { config, tour } from './fixtures';

describe('core slots', () => {
  it('uses the first matching schedule rule and emits local-offset starts', () => {
    const seasonal = {
      ...tour,
      schedule: [
        { days: [0, 1, 2, 3, 4, 5, 6], from: '01-01', to: '12-31', firstStart: '08:00', lastStart: '08:00', intervalMin: 30 },
        tour.schedule[0]!,
      ],
    };
    expect(scheduleForDate(seasonal, '2026-06-15', config.business.timezone)?.firstStart).toBe('08:00');
    expect(generateSlots(seasonal, '2026-06-15', config.business.timezone)[0]?.start).toBe('2026-06-15T08:00:00.000+01:00');
  });

  it('handles a year-end season range', () => {
    const seasonal = { ...tour, schedule: [{ ...tour.schedule[0]!, from: '11-01', to: '02-28' }] };
    expect(generateSlots(seasonal, '2026-01-15', config.business.timezone)).not.toHaveLength(0);
    expect(generateSlots(seasonal, '2026-06-15', config.business.timezone)).toHaveLength(0);
  });

  it('resolves Lisbon DST wall times', () => {
    const spring = generateSlots(tour, '2026-03-29', config.business.timezone)[0];
    const autumn = generateSlots(tour, '2026-10-25', config.business.timezone)[0];
    expect(spring?.utcStart).toBe('2026-03-29T08:00:00.000Z');
    expect(autumn?.utcStart).toBe('2026-10-25T09:00:00.000Z');
  });
});
