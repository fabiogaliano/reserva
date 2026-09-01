import { minorUnitDigits, toMajorUnits } from '../core/currency';
import { parseUtcInstant } from '../core/time';

// Booking summaries carry local ISO strings with an explicit offset, so parsing them yields the
// correct instant and Intl re-projects it into the business timezone for display.
export function formatDateTime(isoWithOffset: string, locale: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(parseUtcInstant(isoWithOffset));
  } catch {
    return isoWithOffset;
  }
}

// Formats a plain YYYY-MM-DD business-day key. Pinning both the parse and the formatter to UTC
// keeps the calendar date exactly as written — no timezone re-projection can shift it a day.
export function formatDayDate(dateKey: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${dateKey}T00:00:00Z`));
  } catch {
    return dateKey;
  }
}

// Split date parts for the confirmation "ticket" date block (big day numeral / month / time).
export function formatDateParts(isoWithOffset: string, locale: string, timezone: string): { day: string; month: string; time: string } | null {
  try {
    const date = parseUtcInstant(isoWithOffset);
    const part = (options: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat(locale, { timeZone: timezone, ...options }).format(date);
    return {
      day: part({ day: 'numeric' }),
      month: part({ month: 'short' }),
      time: part({ hour: '2-digit', minute: '2-digit' }),
    };
  } catch {
    return null;
  }
}

export function formatPrice(amountMinor: number, locale: string, currency: string): string {
  const major = toMajorUnits(amountMinor, currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(major);
  } catch {
    return `${major.toFixed(minorUnitDigits(currency))} ${currency.toUpperCase()}`;
  }
}

function calendarStamp(isoWithOffset: string): string {
  return parseUtcInstant(isoWithOffset).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${calendarStamp(event.start)}/${calendarStamp(event.end)}`,
    location: event.location,
    details: event.description,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function icsDataUrl(event: CalendarEvent): string {
  const escapeIcs = (value: string): string => value.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//reserva//EN',
    'BEGIN:VEVENT',
    `UID:${calendarStamp(event.start)}-reserva`,
    `DTSTAMP:${calendarStamp(event.start)}`,
    `DTSTART:${calendarStamp(event.start)}`,
    `DTEND:${calendarStamp(event.end)}`,
    `SUMMARY:${escapeIcs(event.title)}`,
    `LOCATION:${escapeIcs(event.location)}`,
    `DESCRIPTION:${escapeIcs(event.description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}
