import { describe, expect, it } from 'vitest';
import { formatDateTimeRange, formatDayDate } from '../src/ui/format';

describe('formatDayDate', () => {
  const now = new Date('2026-12-20T10:00:00Z');

  it('omits the year for a day in the current year', () => {
    expect(formatDayDate('2026-12-28', 'en', now)).not.toMatch(/2026/);
  });

  it('names the year for a day in another year, so next January is not mistaken for this one', () => {
    expect(formatDayDate('2027-01-03', 'en', now)).toMatch(/2027/);
  });
});

describe('formatDateTimeRange', () => {
  it('keeps a same-day booking to one date with the end time only', () => {
    expect(formatDateTimeRange('2026-06-15T09:00:00.000+01:00', '2026-06-15T10:00:00.000+01:00', 'en', 'Europe/Lisbon'))
      .toBe('Mon, 15 June 2026 at 09:00 – 10:00');
  });

  it('names the end date when the booking ends on another business-local day', () => {
    const range = formatDateTimeRange('2026-06-15T22:00:00.000+01:00', '2026-06-16T02:00:00.000+01:00', 'en', 'Europe/Lisbon');
    expect(range).toBe('Mon, 15 June 2026 at 22:00 – Tue, 16 June 2026 at 02:00');
  });

  it('decides "another day" in the business timezone, not UTC', () => {
    // 23:30–00:30 UTC is 00:30–01:30 on one Lisbon summer day.
    expect(formatDateTimeRange('2026-06-15T23:30:00.000Z', '2026-06-16T00:30:00.000Z', 'en', 'Europe/Lisbon'))
      .toBe('Tue, 16 June 2026 at 00:30 – 01:30');
  });
});
