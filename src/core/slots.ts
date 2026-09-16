import type { ResolvedScheduleRule, ResolvedServiceConfig } from './config.js';
import { addMinutes, localDateAndTimeToUtc, localDateToWeekday, utcToLocalIso } from './time.js';

export interface GeneratedSlot {
  start: string;
  end: string;
  utcStart: string;
  utcEnd: string;
  localDate: string;
  localTime: string;
}

function monthDayValue(value: string): number {
  const [month = 0, day = 0] = value.split('-').map(Number);
  return month * 100 + day;
}

function matchesSeason(rule: ResolvedScheduleRule, date: string): boolean {
  const monthDay = monthDayValue(date.slice(5));
  const from = rule.from ? monthDayValue(rule.from) : 101;
  const to = rule.to ? monthDayValue(rule.to) : 1231;
  return from <= to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to;
}

export function scheduleRulesForDate(service: ResolvedServiceConfig, date: string, timezone: string): ResolvedScheduleRule[] {
  const weekday = localDateToWeekday(date, timezone);
  return service.schedule.filter((rule) => rule.days.includes(weekday) && matchesSeason(rule, date));
}

export function generateSlots(service: ResolvedServiceConfig, date: string, timezone: string): GeneratedSlot[] {
  // Every rule matching the date contributes; a split day (morning + evening rules) keeps both windows.
  const rules = scheduleRulesForDate(service, date, timezone);
  const byStart = new Map<string, GeneratedSlot>();
  for (const rule of rules) {
    const [firstHour = 0, firstMinute = 0] = rule.firstStart.split(':').map(Number);
    const [lastHour = 0, lastMinute = 0] = rule.lastStart.split(':').map(Number);
    const first = firstHour * 60 + firstMinute;
    const last = lastHour * 60 + lastMinute;
    for (let minutes = first; minutes <= last; minutes += rule.intervalMin) {
      const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
      const minute = String(minutes % 60).padStart(2, '0');
      const localTime = `${hour}:${minute}`;
      try {
        const utcStartDate = localDateAndTimeToUtc(date, localTime, timezone);
        const utcEndDate = addMinutes(utcStartDate, service.durationMin);
        const slot: GeneratedSlot = {
          start: utcToLocalIso(utcStartDate, timezone),
          end: utcToLocalIso(utcEndDate, timezone),
          utcStart: utcStartDate.toISOString(),
          utcEnd: utcEndDate.toISOString(),
          localDate: date,
          localTime,
        };
        if (!byStart.has(slot.start)) byStart.set(slot.start, slot);
      } catch {
        continue;
      }
    }
  }
  return [...byStart.values()].sort((left, right) => left.utcStart.localeCompare(right.utcStart));
}

export const generateSlotStarts = (service: ResolvedServiceConfig, date: string, timezone: string): string[] =>
  generateSlots(service, date, timezone).map((slot) => slot.start);
