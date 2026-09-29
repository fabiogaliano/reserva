import { TZDate } from '@date-fns/tz';
import { describe, expect, it } from 'vitest';
import { localDateTimeToUtcIso, localDateToWeekday, utcToLocalDateTime, utcToLocalIso } from '../src/core/time';

// The TZDate-only conversions the offset cache replaced, kept verbatim as the reference: the cache
// may only change how fast an answer comes, never the answer.
function referenceLocalDateTime(ms: number, timezone: string): string {
  const zoned = new TZDate(ms, timezone);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(zoned.getFullYear(), 4)}-${pad(zoned.getMonth() + 1)}-${pad(zoned.getDate())}T${pad(zoned.getHours())}:${pad(zoned.getMinutes())}`;
}

function referenceLocalToUtc(value: string, timezone: string): string | null {
  const [datePart = '', timePart = ''] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number) as [number, number, number];
  const [hour, minute] = timePart.split(':').map(Number) as [number, number];
  const wallTimeAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 12) offsets.add(new TZDate(wallTimeAsUtc + hours * 3_600_000, timezone).getTimezoneOffset());
  const instant = [...offsets]
    .map((offset) => wallTimeAsUtc + offset * 60_000)
    .filter((candidate) => referenceLocalDateTime(candidate, timezone) === value)
    .sort((left, right) => left - right)[0];
  return instant === undefined ? null : new Date(instant).toISOString();
}

// Half-hour and 45-minute offsets, a 30-minute DST shift, southern-hemisphere DST, a zone that
// suspends DST for Ramadan, and one with no DST at all.
const zones = ['Europe/Lisbon', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'America/St_Johns', 'Pacific/Chatham', 'Africa/Casablanca', 'Asia/Tehran', 'UTC'];
const from = Date.UTC(2026, 0, 1);
const to = Date.UTC(2028, 0, 1);

// Every quarter hour within six hours of each offset change, plus a sparse sweep of the rest whose
// odd step still lands on every quarter-hour position: dense where the cache must step aside.
function instantsToCheck(zone: string): number[] {
  const instants = new Set<number>();
  for (let ms = from; ms < to; ms += 7 * 3_600_000 + 15 * 60_000) instants.add(ms);
  for (let ms = from; ms < to; ms += 3_600_000) {
    if (new TZDate(ms, zone).getTimezoneOffset() === new TZDate(ms + 3_600_000, zone).getTimezoneOffset()) continue;
    for (let near = ms - 6 * 3_600_000; near <= ms + 6 * 3_600_000; near += 15 * 60_000) instants.add(near);
  }
  return [...instants];
}

describe('zone offset cache', () => {
  it.each(zones)('formats instants across 2026-2027 exactly as TZDate does in %s', (zone) => {
    for (const ms of instantsToCheck(zone)) {
      const expectedLocal = referenceLocalDateTime(ms, zone);
      if (utcToLocalDateTime(new Date(ms), zone) !== expectedLocal) expect(utcToLocalDateTime(new Date(ms), zone)).toBe(expectedLocal);
      const expectedIso = new TZDate(ms, zone).toISOString();
      if (utcToLocalIso(new Date(ms), zone) !== expectedIso) expect(utcToLocalIso(new Date(ms), zone)).toBe(expectedIso);
    }
  });

  it.each(zones)('resolves wall times across 2026-2027 to the same instant as before in %s', (zone) => {
    // Each instant read through the offset in force hours before and hours after it: near a change
    // one of the two lands on the skipped (spring-forward) or repeated (fall-back) local times.
    const walls = new Set<string>();
    for (const ms of instantsToCheck(zone)) {
      for (const shift of [-7, 7]) {
        const offset = new TZDate(ms + shift * 3_600_000, zone).getTimezoneOffset();
        walls.add(new Date(ms - offset * 60_000).toISOString().slice(0, 16));
      }
    }
    for (const wall of walls) {
      const expected = referenceLocalToUtc(wall, zone);
      let actual: string | null;
      try {
        actual = localDateTimeToUtcIso(wall, zone);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        actual = null;
      }
      if (actual !== expected) expect({ wall, actual }).toEqual({ wall, actual: expected });
    }
  });

  it('keeps the earlier instant for a repeated fall-back hour and rejects a skipped spring-forward one', () => {
    expect(localDateTimeToUtcIso('2026-10-25T01:30', 'Europe/Lisbon')).toBe('2026-10-25T00:30:00.000Z');
    expect(() => localDateTimeToUtcIso('2026-03-29T01:30', 'Europe/Lisbon')).toThrow(RangeError);
  });

  it('names the weekday of a calendar date without consulting the zone', () => {
    for (let day = 0; day < 800; day += 1) {
      const date = new Date(from + day * 86_400_000).toISOString().slice(0, 10);
      const [year, month, dayOfMonth] = date.split('-').map(Number) as [number, number, number];
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/Lisbon']) {
        expect(localDateToWeekday(date, zone)).toBe(new TZDate(year, month - 1, dayOfMonth, 12, 0, 0, 0, zone).getDay());
      }
    }
  });
});
