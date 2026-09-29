import { TZDate, tzOffset } from '@date-fns/tz';

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateTimePattern = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)$/;

function assertDateParts(year: number, month: number, day: number): void {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date: ${year}-${month}-${day}`);
  }
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = datePattern.exec(date);
  if (!match) throw new RangeError(`Expected YYYY-MM-DD, received ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertDateParts(year, month, day);
  return { year, month, day };
}

function parseLocalDateTime(value: string): LocalDateTimeParts {
  const match = dateTimePattern.exec(value);
  if (!match) throw new RangeError(`Expected local YYYY-MM-DDTHH:mm, received ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  assertDateParts(year, month, day);
  return { year, month, day, hour, minute };
}

const HOUR_MS = 3_600_000;
const OFFSET_CACHE_LIMIT = 50_000;
const hourOffsets = new Map<string, number>();

// Every conversion below reduces to "the zone's UTC offset at this instant", and asking Intl for it
// costs microseconds a call: availability for a few months asks it tens of thousands of times,
// enough on its own to exceed a Worker's CPU budget. An offset holds for whole UTC hours outside the
// rare hour a transition falls in, so it is cached per hour, and only when both ends of the hour
// agree (no zone changes offset twice within an hour). Undefined sends the caller to TZDate: a
// transition hour, a pre-standard-time offset with seconds, or an invalid zone.
function cachedOffsetMinutes(ms: number, timezone: string): number | undefined {
  const hourStart = Math.floor(ms / HOUR_MS) * HOUR_MS;
  const key = `${timezone}|${hourStart}`;
  const cached = hourOffsets.get(key);
  if (cached !== undefined) return cached;
  const atStart = tzOffset(timezone, new Date(hourStart));
  if (!Number.isInteger(atStart) || tzOffset(timezone, new Date(hourStart + HOUR_MS - 1)) !== atStart) return undefined;
  if (hourOffsets.size >= OFFSET_CACHE_LIMIT) hourOffsets.clear();
  hourOffsets.set(key, atStart);
  return atStart;
}

const dayOffsets = new Map<string, number | null>();

// The exact search below probes offsets up to 48 hours either side of a wall time and verifies each
// candidate instant, all inside [day start - 48h, day end + 48h] read as UTC. When every hour of
// that window has one offset, that offset is the only candidate and it verifies, so every wall time
// on the date converts by subtraction; null marks a date near a transition, left to the search.
function constantOffsetAroundDate(year: number, month: number, day: number, timezone: string): number | null {
  const key = `${timezone}|${year}-${month}-${day}`;
  const cached = dayOffsets.get(key);
  if (cached !== undefined) return cached;
  const dayStart = Date.UTC(year, month - 1, day);
  let offset: number | null | undefined;
  for (let hour = dayStart - 48 * HOUR_MS; hour <= dayStart + 72 * HOUR_MS; hour += HOUR_MS) {
    const atHour = cachedOffsetMinutes(hour, timezone);
    if (atHour === undefined || (offset !== undefined && atHour !== offset)) {
      offset = null;
      break;
    }
    offset = atHour;
  }
  const result = offset ?? null;
  if (dayOffsets.size >= OFFSET_CACHE_LIMIT) dayOffsets.clear();
  dayOffsets.set(key, result);
  return result;
}

function localWallClock(ms: number, offsetMinutes: number): Date {
  return new Date(ms + offsetMinutes * 60_000);
}

export function localDateTimeToUtc(value: string, timezone: string): Date {
  const parts = parseLocalDateTime(value);
  const wallTimeAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const constant = constantOffsetAroundDate(parts.year, parts.month, parts.day, timezone);
  if (constant !== null) return new Date(wallTimeAsUtc - constant * 60_000);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 12) {
    const probe = wallTimeAsUtc + hours * 60 * 60_000;
    const cached = cachedOffsetMinutes(probe, timezone);
    const offset = cached === undefined ? new TZDate(probe, timezone).getTimezoneOffset() : -cached;
    if (Number.isFinite(offset)) offsets.add(offset);
  }
  const matchingInstants = [...offsets]
    .map((offset) => new Date(wallTimeAsUtc + offset * 60_000))
    .filter((instant) => utcToLocalDateTime(instant, timezone) === value)
    .sort((left, right) => left.getTime() - right.getTime());
  const instant = matchingInstants[0];
  if (!instant) throw new RangeError(`Local date-time does not exist in ${timezone}: ${value}`);
  return instant;
}

export function localDateTimeToUtcIso(value: string, timezone: string): string {
  return localDateTimeToUtc(value, timezone).toISOString();
}

// A few zones spring forward at midnight itself, so 00:00 does not exist on that date; the day
// then starts at the first wall-clock hour that does.
export function localDayStartUtcIso(date: string, timezone: string): string {
  try {
    return localDateTimeToUtcIso(`${date}T00:00`, timezone);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return localDateTimeToUtcIso(`${date}T01:00`, timezone);
  }
}

export function localDateAndTimeToUtc(date: string, time: string, timezone: string): Date {
  return localDateTimeToUtc(`${date}T${time}`, timezone);
}

export function utcToLocalDateTime(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : parseUtcInstant(value);
  const offset = cachedOffsetMinutes(date.getTime(), timezone);
  if (offset !== undefined) {
    const local = localWallClock(date.getTime(), offset);
    return `${String(local.getUTCFullYear()).padStart(4, '0')}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}T${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  }
  const zoned = new TZDate(date.getTime(), timezone);
  const year = String(zoned.getFullYear()).padStart(4, '0');
  const month = String(zoned.getMonth() + 1).padStart(2, '0');
  const day = String(zoned.getDate()).padStart(2, '0');
  const hour = String(zoned.getHours()).padStart(2, '0');
  const minute = String(zoned.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function utcToLocalIso(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : parseUtcInstant(value);
  const offset = cachedOffsetMinutes(date.getTime(), timezone);
  if (offset === undefined) return new TZDate(date.getTime(), timezone).toISOString();
  // TZDate's format: the wall clock without "Z", then ±HH:MM ("+00:00" for UTC itself).
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${localWallClock(date.getTime(), offset).toISOString().slice(0, -1)}${offset < 0 ? '-' : '+'}${hours}:${minutes}`;
}

export function localDateKey(value: string | Date, timezone: string): string {
  const local = utcToLocalDateTime(value, timezone);
  return local.slice(0, 10);
}

// A calendar date's weekday is the same in every zone, so no zone lookup is needed; the parameter
// stays for callers that pass one.
export function localDateToWeekday(date: string, _timezone: string): number {
  const parts = parseDate(date);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function parseUtcInstant(value: string | Date): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError('Invalid UTC instant');
    return new Date(value.getTime());
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(value);
  if (!match) throw new RangeError(`UTC instant must be ISO 8601 with an explicit offset: ${value}`);
  assertDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new RangeError(`Invalid UTC instant: ${value}`);
  return result;
}

export function addMinutes(value: string | Date, minutes: number): Date {
  return new Date(parseUtcInstant(value).getTime() + minutes * 60_000);
}

export function addMinutesIso(value: string | Date, minutes: number): string {
  return addMinutes(value, minutes).toISOString();
}

export function compareInstants(left: string | Date, right: string | Date): number {
  return parseUtcInstant(left).getTime() - parseUtcInstant(right).getTime();
}

export function formatLocalDate(value: string | Date, timezone: string): string {
  return localDateKey(value, timezone);
}

export function formatLocalTime(value: string | Date, timezone: string): string {
  return utcToLocalDateTime(value, timezone).slice(11, 16);
}

export function addDaysToDateKey(date: string, days: number): string {
  const parts = parseDate(date);
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer, received ${days}`);
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  probe.setUTCDate(probe.getUTCDate() + days);
  const year = String(probe.getUTCFullYear()).padStart(4, '0');
  const month = String(probe.getUTCMonth() + 1).padStart(2, '0');
  const day = String(probe.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function enumerateDateKeys(from: string, to: string): string[] {
  parseDate(from);
  parseDate(to);
  const result: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    result.push(cursor);
    cursor = addDaysToDateKey(cursor, 1);
  }
  return result;
}
