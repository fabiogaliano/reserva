// Calendar-shaped reads of an availability response. Every consumer that renders a date picker
// wrote these four one-liners itself (and each got the UTC/local question wrong at least once), so
// they ship with the client instead.

import type { AvailabilityDay, AvailabilityResponse, CatalogResponse } from '../core/api.js';

const DAY_MS = 86_400_000;

// UTC getters, not local: cally hands `isDateDisallowed` dates built with `Date.UTC`, so local
// getters would read back the previous day in any timezone behind UTC.
export function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// A day with no slots is closed, sold out, or past its notice window — indistinguishable to a
// picker, which only ever asks "can this date be chosen".
export function openDays(response: Pick<AvailabilityResponse, 'days'>): AvailabilityDay[] {
  return response.days.filter((day) => day.slots.length > 0);
}

export function firstOpenDay(response: Pick<AvailabilityResponse, 'days'>): AvailabilityDay | null {
  return response.days.find((day) => day.slots.length > 0) ?? null;
}

// Built once per response and handed to the calendar: a day absent from the payload is disallowed
// too, so a range narrower than the rendered month greys out rather than looking bookable.
export function isDayDisallowed(response: Pick<AvailabilityResponse, 'days'>): (date: Date) => boolean {
  const days = new Map(response.days.map((day) => [day.date, day]));
  return (date: Date): boolean => (days.get(dateKey(date))?.slots.length ?? 0) === 0;
}

// The widest range the deployment will answer for, so a funnel asks for the whole horizon in one
// request instead of guessing a window and re-fetching when the visitor pages forward.
export function horizonRange(
  catalog: Pick<CatalogResponse, 'maxHorizonDays'>,
  today: string,
): { from: string; to: string } {
  return { from: today, to: dateKey(new Date(Date.parse(`${today}T00:00:00Z`) + catalog.maxHorizonDays * DAY_MS)) };
}
