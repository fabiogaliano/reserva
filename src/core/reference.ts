import { utcToLocalDateTime } from './time.js';

function validCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function referenceYear(value: number | string | Date, timezone?: string): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) {
    const local = timezone ? utcToLocalDateTime(value, timezone) : value.toISOString();
    return Number(local.slice(0, 4));
  }
  if (/^\d{4}$/.test(value)) return Number(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value);
  if (!match) throw new RangeError(`Unable to determine reference year from ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validCalendarDate(year, month, day)) throw new RangeError(`Invalid reference date: ${value}`);
  return year;
}

export function formatReference(shortCode: string, year: number, sequence: number): string {
  if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(shortCode)) throw new RangeError('Invalid business shortCode');
  if (!Number.isInteger(year) || year < 1) throw new RangeError('Invalid reference year');
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError('Invalid reference sequence');
  return `${shortCode.toUpperCase()}-${year}-${String(sequence).padStart(3, '0')}`;
}

export function generateReference(
  shortCode: string,
  yearOrDate: number | string | Date,
  sequence: number,
  timezone?: string,
): string {
  return formatReference(shortCode, referenceYear(yearOrDate, timezone), sequence);
}

export function nextReference(
  shortCode: string,
  yearOrDate: number | string | Date,
  existingReferences: Iterable<string> = [],
  timezone?: string,
): string {
  const year = referenceYear(yearOrDate, timezone);
  const prefix = `${shortCode.toUpperCase()}-${year}-`;
  const existing = new Set(existingReferences);
  let sequence = [...existing].filter((reference) => reference.startsWith(prefix)).length + 1;
  let candidate = formatReference(shortCode, year, sequence);
  while (existing.has(candidate)) {
    sequence += 1;
    candidate = formatReference(shortCode, year, sequence);
  }
  return candidate;
}

export async function generateUniqueReference(
  shortCode: string,
  yearOrDate: number | string | Date,
  initialSequence: number,
  exists: (reference: string) => boolean | Promise<boolean>,
  timezone?: string,
): Promise<string> {
  const year = referenceYear(yearOrDate, timezone);
  let sequence = initialSequence;
  while (await exists(formatReference(shortCode, year, sequence))) sequence += 1;
  return formatReference(shortCode, year, sequence);
}
