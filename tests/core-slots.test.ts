import { describe, expect, it } from 'vitest';
import { generateSlots, scheduleRulesForDate } from '../src/core/slots';
import { config, service } from './fixtures';

describe('core slots', () => {
  it('combines every matching schedule rule and emits local-offset starts', () => {
    const seasonal = {
      ...service,
      schedule: [
        { days: [0, 1, 2, 3, 4, 5, 6], from: '01-01', to: '12-31', firstStart: '08:00', lastStart: '08:00', intervalMin: 30 },
        service.schedule[0]!,
      ],
    };
    // Union, not first-match: the seasonal rule's 08:00 and the base rule's 09:00–12:00 both stand.
    expect(scheduleRulesForDate(seasonal, '2026-06-15', config.business.timezone).map((rule) => rule.firstStart))
      .toEqual(['08:00', '09:00']);
    const starts = generateSlots(seasonal, '2026-06-15', config.business.timezone).map((slot) => slot.localTime);
    expect(starts).toEqual(['08:00', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00']);
    expect(generateSlots(seasonal, '2026-06-15', config.business.timezone)[0]?.start).toBe('2026-06-15T08:00:00.000+01:00');
  });

  it('keeps both windows of a split day, in ascending order', () => {
    const splitDay = {
      ...service,
      schedule: [
        { days: [1, 2, 3, 4, 5], firstStart: '07:00', lastStart: '09:00', intervalMin: 60 },
        { days: [1, 2, 3, 4, 5], firstStart: '18:00', lastStart: '20:00', intervalMin: 60 },
      ],
    };
    // 2026-06-15 is a Monday.
    expect(generateSlots(splitDay, '2026-06-15', config.business.timezone).map((slot) => slot.localTime))
      .toEqual(['07:00', '08:00', '09:00', '18:00', '19:00', '20:00']);
  });

  it('emits one slot when two matching rules land on the same start', () => {
    const overlapping = {
      ...service,
      schedule: [
        { days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '10:00', intervalMin: 60 },
        { days: [0, 1, 2, 3, 4, 5, 6], firstStart: '10:00', lastStart: '11:00', intervalMin: 60 },
      ],
    };
    expect(generateSlots(overlapping, '2026-06-15', config.business.timezone).map((slot) => slot.localTime))
      .toEqual(['09:00', '10:00', '11:00']);
  });

  it('handles a year-end season range', () => {
    const seasonal = { ...service, schedule: [{ ...service.schedule[0]!, from: '11-01', to: '02-28' }] };
    expect(generateSlots(seasonal, '2026-01-15', config.business.timezone)).not.toHaveLength(0);
    expect(generateSlots(seasonal, '2026-06-15', config.business.timezone)).toHaveLength(0);
  });

  it('resolves Lisbon DST wall times', () => {
    const spring = generateSlots(service, '2026-03-29', config.business.timezone)[0];
    const autumn = generateSlots(service, '2026-10-25', config.business.timezone)[0];
    expect(spring?.utcStart).toBe('2026-03-29T08:00:00.000Z');
    expect(autumn?.utcStart).toBe('2026-10-25T09:00:00.000Z');
  });
});
