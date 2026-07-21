import { describe, expect, it } from 'vitest';
import { formatReference, generateReference, generateUniqueReference, nextReference } from '../src/core/reference';

describe('core references', () => {
  it('formats and rolls the year correctly', () => {
    expect(formatReference('LVT', 2026, 14)).toBe('LVT-2026-014');
    expect(generateReference('LVT', '2027-01-01T00:00:00.000Z', 1)).toBe('LVT-2027-001');
  });

  it('retries a same-year collision after the count-derived sequence', async () => {
    expect(nextReference('LVT', 2026, ['LVT-2026-001', 'LVT-2026-003'])).toBe('LVT-2026-004');
    expect(await generateUniqueReference('LVT', 2026, 3, (reference) => reference === 'LVT-2026-003')).toBe('LVT-2026-004');
  });
});
