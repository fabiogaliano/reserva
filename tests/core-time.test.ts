import { describe, expect, it } from 'vitest';
import { addMinutes, fallBackAmbiguityPolicy, localDateTimeToUtcIso, parseUtcInstant, utcToLocalIso } from '../src/core/time';
import { canCancelBooking, cancellationDeadline } from '../src/core/booking';
import { booking } from './fixtures';

describe('core time', () => {
  it('converts Lisbon spring-forward wall time using the summer offset', () => {
    expect(localDateTimeToUtcIso('2026-03-29T10:00', 'Europe/Lisbon')).toBe('2026-03-29T09:00:00.000Z');
    expect(utcToLocalIso('2026-03-29T09:00:00.000Z', 'Europe/Lisbon')).toBe('2026-03-29T10:00:00.000+01:00');
  });

  it('converts Lisbon fall-back wall time using standard time', () => {
    expect(localDateTimeToUtcIso('2026-10-25T10:00', 'Europe/Lisbon')).toBe('2026-10-25T10:00:00.000Z');
    expect(utcToLocalIso('2026-10-25T10:00:00.000Z', 'Europe/Lisbon')).toBe('2026-10-25T10:00:00.000+00:00');
  });

  it('keeps elapsed duration across the fall-back transition', () => {
    const start = localDateTimeToUtcIso('2026-10-25T00:30', 'Europe/Lisbon');
    const end = addMinutes(start, 180);
    expect(start).toBe('2026-10-24T23:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T02:30:00.000Z');
    expect(utcToLocalIso(end, 'Europe/Lisbon')).toBe('2026-10-25T02:30:00.000+00:00');
  });

  it('chooses the earlier occurrence for an ambiguous fall-back wall time', () => {
    expect(fallBackAmbiguityPolicy).toBe('earlier');
    expect(localDateTimeToUtcIso('2026-10-25T01:30', 'Europe/Lisbon')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('rejects rollover dates and instants without explicit offsets', () => {
    expect(() => parseUtcInstant('2026-06-31T08:00:00Z')).toThrow(/calendar date/i);
    expect(() => parseUtcInstant('2026-06-30T08:00:00')).toThrow(/explicit offset/i);
  });

  it('treats the cancellation cutoff boundary as allowed', () => {
    const b = booking({ startsAt: '2026-06-15T12:00:00.000Z' });
    const deadline = cancellationDeadline(b, 24);
    expect(deadline.toISOString()).toBe('2026-06-14T12:00:00.000Z');
    expect(canCancelBooking(b, deadline, 24)).toBe(true);
    expect(canCancelBooking(b, '2026-06-14T12:00:00.001Z', 24)).toBe(false);
  });
});
