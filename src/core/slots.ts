import type { ScheduleRule, ServiceConfig } from './config';
import { addMinutes, localDateAndTimeToUtc, localDateToWeekday, utcToLocalIso } from './time';

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

function matchesSeason(rule: ScheduleRule, date: string): boolean {
  const monthDay = monthDayValue(date.slice(5));
  const from = rule.from ? monthDayValue(rule.from) : 101;
  const to = rule.to ? monthDayValue(rule.to) : 1231;
  return from <= to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to;
}

export function scheduleForDate(service: ServiceConfig, date: string, timezone: string): ScheduleRule | undefined {
  const weekday = localDateToWeekday(date, timezone);
  return service.schedule.find((rule) => rule.days.includes(weekday) && matchesSeason(rule, date));
}

export const getScheduleForDate = scheduleForDate;

export function generateSlots(service: ServiceConfig, date: string, timezone: string): GeneratedSlot[] {
  const rule = scheduleForDate(service, date, timezone);
  if (!rule) return [];
  const [firstHour = 0, firstMinute = 0] = rule.firstStart.split(':').map(Number);
  const [lastHour = 0, lastMinute = 0] = rule.lastStart.split(':').map(Number);
  const first = firstHour * 60 + firstMinute;
  const last = lastHour * 60 + lastMinute;
  const slots: GeneratedSlot[] = [];
  for (let minutes = first; minutes <= last; minutes += rule.intervalMin) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
    const minute = String(minutes % 60).padStart(2, '0');
    const localTime = `${hour}:${minute}`;
    try {
      const utcStartDate = localDateAndTimeToUtc(date, localTime, timezone);
      const utcEndDate = addMinutes(utcStartDate, service.durationMin);
      slots.push({
        start: utcToLocalIso(utcStartDate, timezone),
        end: utcToLocalIso(utcEndDate, timezone),
        utcStart: utcStartDate.toISOString(),
        utcEnd: utcEndDate.toISOString(),
        localDate: date,
        localTime,
      });
    } catch {
      continue;
    }
  }
  return slots;
}

export const slotsForDate = generateSlots;
export const generateSlotStarts = (service: ServiceConfig, date: string, timezone: string): string[] =>
  generateSlots(service, date, timezone).map((slot) => slot.start);
