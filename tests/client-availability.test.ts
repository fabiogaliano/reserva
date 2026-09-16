import { describe, expect, it } from 'vitest';
import { dateKey, firstOpenDay, horizonRange, isDayDisallowed, openDays } from '../src/client/availability';
import type { AvailabilityDay, AvailabilityResponse } from '../src/core/api';

function day(date: string, times: string[], status: AvailabilityDay['status']): AvailabilityDay {
  return {
    date,
    status,
    closedReason: null,
    slots: times.map((time) => ({ start: `${date}T${time}:00.000+01:00`, date, time, remaining: null })),
  };
}

// A closed day in the middle, so "first open" and "drop the closed ones" can't both be satisfied
// by simply taking the head of the list.
const response: Pick<AvailabilityResponse, 'days'> = {
  days: [
    day('2026-06-15', [], 'closed'),
    day('2026-06-16', ['09:00', '11:00'], 'available'),
    day('2026-06-17', [], 'full'),
    day('2026-06-18', ['09:00'], 'limited'),
  ],
};

describe('availability calendar reads', () => {
  it('keeps only days a visitor can actually book, in payload order', () => {
    expect(openDays(response).map((entry) => entry.date)).toEqual(['2026-06-16', '2026-06-18']);
  });

  it('finds the first bookable day, and reports none when the whole window is shut', () => {
    expect(firstOpenDay(response)?.date).toBe('2026-06-16');
    expect(firstOpenDay({ days: [day('2026-06-15', [], 'closed'), day('2026-06-17', [], 'full')] })).toBeNull();
  });

  it('disallows closed days and any date the response never mentioned', () => {
    const disallowed = isDayDisallowed(response);
    expect(disallowed(new Date(Date.UTC(2026, 5, 16)))).toBe(false);
    expect(disallowed(new Date(Date.UTC(2026, 5, 15)))).toBe(true);
    expect(disallowed(new Date(Date.UTC(2026, 5, 17)))).toBe(true);
    // Outside the requested window: greyed out rather than looking bookable.
    expect(disallowed(new Date(Date.UTC(2026, 11, 25)))).toBe(true);
  });

  it('reads a date in UTC, so neither end of the day drifts into a neighbouring one', () => {
    // Whatever the runner's timezone, one of these two would fall on another calendar day if the
    // key were built from local getters.
    expect(dateKey(new Date('2026-06-15T00:30:00Z'))).toBe('2026-06-15');
    expect(dateKey(new Date('2026-06-15T23:30:00Z'))).toBe('2026-06-15');
    expect(dateKey(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05');
  });

  it('spans the deployment horizon from today, counting whole days across a DST change', () => {
    expect(horizonRange({ maxHorizonDays: 180 }, '2026-06-15')).toEqual({ from: '2026-06-15', to: '2026-12-12' });
    // Europe's clocks go forward on 2026-03-29; the horizon is still 14 calendar days.
    expect(horizonRange({ maxHorizonDays: 14 }, '2026-03-20')).toEqual({ from: '2026-03-20', to: '2026-04-03' });
  });
});
