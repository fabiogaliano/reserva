import { describe, expect, it } from 'vitest';
import { formatDayDate } from '../src/ui/format';

describe('formatDayDate', () => {
  const now = new Date('2026-12-20T10:00:00Z');

  it('omits the year for a day in the current year', () => {
    expect(formatDayDate('2026-12-28', 'en', now)).not.toMatch(/2026/);
  });

  it('names the year for a day in another year, so next January is not mistaken for this one', () => {
    expect(formatDayDate('2027-01-03', 'en', now)).toMatch(/2027/);
  });
});
