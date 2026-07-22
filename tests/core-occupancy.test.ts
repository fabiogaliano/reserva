import { describe, expect, it } from 'vitest';
import {
  availabilityForDay,
  capacityForDate,
  defaultCapacityForDate,
  getOccupancyIntervals,
  isSlotAvailable,
  maxConcurrentOccupancy,
  remainingCapacity,
} from '../src/core/occupancy';
import { booking, config, tour } from './fixtures';

const slotStart = '2026-06-15T09:00:00.000Z';
const slotEnd = '2026-06-15T10:00:00.000Z';

function occupancyOptions(overrides: Partial<Parameters<typeof getOccupancyIntervals>[0]> = {}) {
  return {
    bookings: [],
    tour,
    now: '2026-06-15T08:00:00.000Z',
    ...overrides,
  };
}

describe('core occupancy', () => {
  it('offers a slot with capacity two and one one-vehicle booking', () => {
    const intervals = getOccupancyIntervals(occupancyOptions({ bookings: [booking()] }));
    expect(isSlotAvailable(slotStart, slotEnd, {
      capacity: 2,
      intervals,
      requestedUnits: 1,
      turnaroundMin: 30,
    })).toBe(true);
  });

  it('uses the booking tour turnaround and occupancy resolver across tours', () => {
    const largeTour = {
      ...tour,
      turnaroundMin: 90,
      occupancyFor: (people: number) => people > 4 ? 2 : 1,
    };
    const intervals = getOccupancyIntervals(occupancyOptions({
      bookings: [booking({ people: 8, tourSlug: 'large' })],
      tours: { large: largeTour },
    }));
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.units).toBe(2);
    expect(intervals[0]?.end).toBe('2026-06-15T11:30:00.000Z');
  });

  it('removes a slot at capacity and treats eight people as two vehicles', () => {
    const one = booking();
    const intervals = getOccupancyIntervals(occupancyOptions({ bookings: [one, booking({ id: 'booking-2', people: 2 })] }));
    expect(isSlotAvailable(slotStart, slotEnd, { capacity: 2, intervals, requestedUnits: 1, turnaroundMin: 30 })).toBe(false);

    const large = getOccupancyIntervals(occupancyOptions({ bookings: [booking({ people: 8 })] }));
    expect(remainingCapacity(2, large, slotStart, '2026-06-15T10:30:00.000Z')).toBe(0);
  });

  it('blocks the following grid slot exactly through turnaround', () => {
    const intervals = getOccupancyIntervals(occupancyOptions({ bookings: [booking()] }));
    expect(isSlotAvailable(slotStart, slotEnd, { capacity: 1, intervals, requestedUnits: 1, turnaroundMin: 30 })).toBe(false);
    expect(isSlotAvailable('2026-06-15T10:30:00.000Z', '2026-06-15T11:30:00.000Z', {
      capacity: 1,
      intervals,
      requestedUnits: 1,
      turnaroundMin: 30,
    })).toBe(true);
  });

  it('clamps an override capacity to zero instead of producing negative availability', () => {
    const result = capacityForDate('2026-06-15', 2, [{ date: '2026-06-15', capacity: 1 }]);
    expect(result.capacity).toBe(1);
    const twoBookings = getOccupancyIntervals(occupancyOptions({
      bookings: [booking(), booking({ id: 'booking-2' })],
    }));
    expect(remainingCapacity(result.capacity, twoBookings, slotStart, '2026-06-15T10:30:00.000Z')).toBe(0);
    const full = availabilityForDay({
      date: '2026-06-15', timezone: config.business.timezone, tour, capacity: 0,
      bookings: [], requestedPeople: 1, limitedThreshold: 2, closedReason: 'vacation',
    });
    expect(full.status).toBe('closed');
    expect(full.closedReason).toBe('vacation');
    expect(full.slots).toEqual([]);
  });

  it('resolves the fleet default from the latest capacity default at or before the date', () => {
    const defaults = [
      { fromDate: '2026-06-10', capacity: 1, reason: 'van in repair' },
      { fromDate: '2026-07-01', capacity: 2, reason: null },
    ];
    expect(defaultCapacityForDate('2026-06-09', 2, defaults)).toBe(2);
    expect(defaultCapacityForDate('2026-06-10', 2, defaults)).toBe(1);
    expect(defaultCapacityForDate('2026-06-30', 2, defaults)).toBe(1);
    expect(defaultCapacityForDate('2026-07-01', 2, defaults)).toBe(2);
    expect(defaultCapacityForDate('2026-06-15', 2, [])).toBe(2);
    // A day override still trumps the ranged default.
    expect(capacityForDate('2026-06-15', defaultCapacityForDate('2026-06-15', 2, defaults), [{ date: '2026-06-15', capacity: 0 }]).capacity).toBe(0);
  });

  it('returns closed for a non-operating day even when capacity is positive', () => {
    const nonOperatingTour = {
      ...tour,
      schedule: [{ ...tour.schedule[0]!, days: [0] }],
    };
    const result = availabilityForDay({
      date: '2026-06-15', timezone: config.business.timezone, tour: nonOperatingTour, capacity: 2,
      bookings: [], requestedPeople: 1, limitedThreshold: 2, now: '2026-06-14T00:00:00.000Z',
    });
    expect(result.status).toBe('closed');
    expect(result.slots).toEqual([]);
  });

  it('skips a nonexistent Lisbon spring-forward slot without failing availability', () => {
    const springTour = {
      ...tour,
      schedule: [{ ...tour.schedule[0]!, firstStart: '01:30', lastStart: '03:00', intervalMin: 30 }],
    };
    const result = availabilityForDay({
      date: '2026-03-29', timezone: config.business.timezone, tour: springTour, capacity: 2,
      bookings: [], requestedPeople: 1, limitedThreshold: 0, now: '2026-03-28T00:00:00.000Z', maxHorizonDays: 3,
    });
    expect(result.status).toBe('available');
    expect(result.slots.map((slot) => slot.start)).not.toContain('2026-03-29T01:30:00.000+00:00');
    expect(result.slots).toHaveLength(3);
  });

  it('skips zero, reversed, and malformed occupancy intervals safely', () => {
    expect(maxConcurrentOccupancy([
      { start: slotStart, end: slotStart, units: 1, source: 'calendar' },
      { start: slotEnd, end: slotStart, units: 1, source: 'calendar' },
      { start: 'not-an-instant', end: slotEnd, units: 1, source: 'calendar' },
    ], slotStart, '2026-06-15T11:00:00.000Z')).toBe(0);
    expect(getOccupancyIntervals(occupancyOptions({
      calendarEvents: [
        { id: 'reversed', start: slotEnd, end: slotStart },
        { id: 'malformed', start: 'not-an-instant', end: slotEnd },
      ],
    }))).toEqual([]);
  });

  it('ignores all-day events and counts a timed event once', () => {
    const intervals = getOccupancyIntervals(occupancyOptions({
      calendarEvents: [
        { id: 'all-day', start: { date: '2026-06-15' }, end: { date: '2026-06-16' }, allDay: true },
        { id: 'timed', start: slotStart, end: slotEnd },
      ],
    }));
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.source).toBe('calendar');
    expect(intervals[0]?.units).toBe(1);
  });

  it('counts a booking that starts before the queried window when it spills in', () => {
    const intervals = getOccupancyIntervals(occupancyOptions({
      from: '2026-06-15T09:30:00.000Z',
      to: '2026-06-15T10:00:00.000Z',
      bookings: [booking({ startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:30:00.000Z' })],
    }));
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.start).toBe('2026-06-15T09:00:00.000Z');
  });

  it('does not double-count a bookkit-tagged calendar event', () => {
    const intervals = getOccupancyIntervals(occupancyOptions({
      bookings: [booking()],
      calendarEvents: [{
        id: 'calendar-copy', start: slotStart, end: slotEnd,
        extendedProperties: { private: { bookkitBookingId: 'booking-1' } },
      }],
    }));
    expect(intervals).toHaveLength(1);
    expect(remainingCapacity(2, intervals, slotStart, '2026-06-15T10:30:00.000Z')).toBe(1);
  });

  it('counts an orphaned tagged calendar event without a matching D1 booking', () => {
    const intervals = getOccupancyIntervals(occupancyOptions({
      bookings: [],
      calendarEvents: [{
        id: 'orphaned-copy', start: slotStart, end: slotEnd,
        extendedProperties: { private: { bookkitBookingId: 'missing-booking' } },
      }],
    }));
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.source).toBe('calendar');
  });

  it('counts a hold at exact expiry until the SQL sweep runs', () => {
    const hold = booking({ status: 'hold', holdExpiresAt: '2026-06-15T08:00:00.000Z' });
    const intervals = getOccupancyIntervals(occupancyOptions({
      now: '2026-06-15T08:00:00.000Z',
      bookings: [hold],
    }));
    expect(intervals).toHaveLength(1);
  });

  it('excludes the moved booking from reschedule validation', () => {
    const moved = booking();
    const intervals = getOccupancyIntervals(occupancyOptions({
      bookings: [moved],
      excludeBookingId: moved.id,
    }));
    expect(intervals).toEqual([]);
    expect(isSlotAvailable(slotStart, slotEnd, { capacity: 1, intervals, requestedUnits: 1, turnaroundMin: 30 })).toBe(true);
  });
});
