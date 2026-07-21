import { TZDate } from '@date-fns/tz';

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export type FallBackAmbiguityPolicy = 'earlier';
export const fallBackAmbiguityPolicy: FallBackAmbiguityPolicy = 'earlier';

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

export function localDateTimeToUtc(value: string, timezone: string): Date {
  const parts = parseLocalDateTime(value);
  const date = new TZDate(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0, timezone);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid local date-time: ${value}`);
  const instant = new Date(date.getTime());
  if (utcToLocalDateTime(instant, timezone) !== value) {
    throw new RangeError(`Local date-time does not exist in ${timezone}: ${value}`);
  }
  return instant;
}

export function localDateTimeToUtcIso(value: string, timezone: string): string {
  return localDateTimeToUtc(value, timezone).toISOString();
}

export function localDateAndTimeToUtc(date: string, time: string, timezone: string): Date {
  return localDateTimeToUtc(`${date}T${time}`, timezone);
}

export function utcToLocalDateTime(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : parseUtcInstant(value);
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
  return new TZDate(date.getTime(), timezone).toISOString();
}

export function localDateKey(value: string | Date, timezone: string): string {
  const local = utcToLocalDateTime(value, timezone);
  return local.slice(0, 10);
}

export function localDateToWeekday(date: string, timezone: string): number {
  const parts = parseDate(date);
  return new TZDate(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0, timezone).getDay();
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
