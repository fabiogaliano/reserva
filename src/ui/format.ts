import { minorUnitDigits, toMajorUnits } from '../core/currency.js';
import { formatLocaleFor } from '../core/locale.js';
import { localDateKey, parseUtcInstant } from '../core/time.js';

// Booking summaries carry local ISO strings with an explicit offset, so parsing them yields the
// correct instant and Intl re-projects it into the business timezone for display.
export function formatDateTime(isoWithOffset: string, locale: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(formatLocaleFor(locale), {
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

// The customer-facing "when" line: one spelled-out date with both ends of the booking, so a
// two-hour tour reads "Sat, 3 May 2026, 14:00 - 16:00" instead of a start time the customer has to
// pair with a duration. Falls back to the start alone when the range can't be formatted.
export function formatDateTimeRange(startIso: string, endIso: string, locale: string, timezone: string): string {
  const start = formatDateTime(startIso, locale, timezone);
  if (!endIso || endIso === startIso) return start;
  try {
    const endInstant = parseUtcInstant(endIso);
    // A booking that runs past midnight (business-local) must say which day it ends on, or an
    // overnight trip reads as ending before it starts.
    const sameDay = localDateKey(parseUtcInstant(startIso), timezone) === localDateKey(endInstant, timezone);
    if (!sameDay) return `${start} – ${formatDateTime(endIso, locale, timezone)}`;
    const endTime = new Intl.DateTimeFormat(formatLocaleFor(locale), {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(endInstant);
    return `${start} – ${endTime}`;
  } catch {
    return start;
  }
}

// Formats a plain YYYY-MM-DD business-day key. Pinning both the parse and the formatter to UTC
// keeps the calendar date exactly as written — no timezone re-projection can shift it a day.
// `now` is injectable so the year rule below is testable without travelling the clock.
export function formatDayDate(dateKey: string, locale: string, now: Date = new Date()): string {
  try {
    const date = new Date(`${dateKey}T00:00:00Z`);
    // "Sat, 3 Jan" is ambiguous every December: a day in another year always names it, so an
    // operator reading a list across New Year can't mistake next January for this one.
    const showYear = date.getUTCFullYear() !== now.getUTCFullYear();
    return new Intl.DateTimeFormat(formatLocaleFor(locale), {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(showYear ? { year: 'numeric' as const } : {}),
    }).format(date);
  } catch {
    return dateKey;
  }
}

// Split date parts for the confirmation "ticket" date block (big day numeral / month / time).
export function formatDateParts(isoWithOffset: string, locale: string, timezone: string): { day: string; month: string; time: string } | null {
  try {
    const date = parseUtcInstant(isoWithOffset);
    const part = (options: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat(formatLocaleFor(locale), { timeZone: timezone, ...options }).format(date);
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
    return new Intl.NumberFormat(formatLocaleFor(locale), { style: 'currency', currency: currency.toUpperCase() }).format(major);
  } catch {
    return `${major.toFixed(minorUnitDigits(currency))} ${currency.toUpperCase()}`;
  }
}

function calendarStamp(isoWithOffset: string | Date): string {
  const instant = typeof isoWithOffset === 'string' ? parseUtcInstant(isoWithOffset) : isoWithOffset;
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
}

// The identity a calendar app files the event under: one per booking, the same in every copy of
// the file and across reschedules (the old start-time UID collided for two bookings sharing a
// start). Whether a re-import replaces the entry is the app's call — no SEQUENCE is emitted. Keyed
// on the booking reference — unique,
// immutable across reschedules, and already on every customer surface — because the pages that
// offer this file are deliberately never given the internal booking id.
export function calendarUid(reference: string, businessUrl: string): string {
  let host = '';
  try {
    host = new URL(businessUrl).host;
  } catch {
    // A config that got past validation always parses; the bare reference is still unique.
  }
  return host ? `${reference}@${host}` : reference;
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

// What an .ics needs beyond the event itself: its stable identity and when the file was produced
// (DTSTAMP).
export interface IcsStamp {
  uid: string;
  generatedAt: Date;
}

// The calendar file itself, shared with the email renderer: the confirmation page hands it to the
// browser as a data URL, the confirmation mail attaches the very same bytes.
export function icsText(event: CalendarEvent, stamp: IcsStamp): string {
  const escapeIcs = (value: string): string => value.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//reserva//EN',
    'BEGIN:VEVENT',
    `UID:${escapeIcs(stamp.uid)}`,
    `DTSTAMP:${calendarStamp(stamp.generatedAt)}`,
    `DTSTART:${calendarStamp(event.start)}`,
    `DTEND:${calendarStamp(event.end)}`,
    `SUMMARY:${escapeIcs(event.title)}`,
    `LOCATION:${escapeIcs(event.location)}`,
    `DESCRIPTION:${escapeIcs(event.description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

export function icsDataUrl(event: CalendarEvent, stamp: IcsStamp): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(icsText(event, stamp))}`;
}
