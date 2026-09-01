import type { ServiceConfig } from './config';
import type { Booking } from './booking';
import type { GeneratedSlot } from './slots';
import { addMinutes, compareInstants, parseUtcInstant } from './time';
import { generateSlots, scheduleForDate } from './slots';

export interface DayCapacityOverride {
  date: string;
  capacity: number;
  reason?: string | null;
}

export interface CalEventTime {
  dateTime?: string;
  date?: string;
}

export interface CalEvent {
  id?: string;
  start: string | CalEventTime;
  end: string | CalEventTime;
  allDay?: boolean;
  extendedProperties?: {
    private?: Record<string, string | undefined>;
    [key: string]: unknown;
  };
  bookkitBookingId?: string;
}

export type OccupancySource = 'booking' | 'calendar';

export interface OccupancyInterval {
  start: string;
  end: string;
  units: number;
  source: OccupancySource;
  bookingId?: string;
  eventId?: string;
}

export type OccupancyService = Pick<ServiceConfig, 'turnaroundMin' | 'occupancyFor'>;
export type OccupancyServiceResolver = (serviceSlug: string) => OccupancyService | undefined;
export type OccupancyServiceMap = ReadonlyMap<string, OccupancyService> | Readonly<Record<string, OccupancyService>>;

export type OccupancyBooking = Pick<Booking, 'id' | 'status' | 'startsAt' | 'endsAt' | 'holdExpiresAt' | 'quantity'> & {
  calendarEventId?: string | null;
  serviceSlug?: string;
};

export interface OccupancyIntervalOptions {
  bookings: readonly OccupancyBooking[];
  calendarEvents?: readonly CalEvent[];
  service: OccupancyService;
  services?: OccupancyServiceMap;
  serviceResolver?: OccupancyServiceResolver;
  resolveService?: OccupancyServiceResolver;
  now?: string | Date;
  from?: string | Date;
  to?: string | Date;
  excludeBookingId?: string;
}

export interface SlotAvailabilityOptions {
  capacity: number;
  intervals: readonly OccupancyInterval[];
  requestedUnits: number;
  turnaroundMin: number;
}

export interface DayAvailabilityOptions {
  date: string;
  timezone: string;
  service: ServiceConfig;
  capacity: number;
  bookings: readonly OccupancyBooking[];
  calendarEvents?: readonly CalEvent[];
  services?: OccupancyServiceMap;
  serviceResolver?: OccupancyServiceResolver;
  resolveService?: OccupancyServiceResolver;
  requestedQuantity: number;
  now?: string | Date;
  minNoticeHours?: number;
  maxHorizonDays?: number;
  limitedThreshold: number;
  closedReason?: string | null;
  excludeBookingId?: string;
}

export interface AvailableSlot {
  start: string;
  remaining: number;
  remainingBookings: number;
}

export interface DayAvailability {
  date: string;
  status: 'available' | 'limited' | 'full' | 'closed';
  closedReason?: string;
  slots: AvailableSlot[];
}

function instantFromValue(value: string | CalEventTime): string | undefined {
  try {
    if (typeof value === 'string') return parseUtcInstant(value).toISOString();
    if (value.dateTime) return parseUtcInstant(value.dateTime).toISOString();
  } catch {
    return undefined;
  }
  return undefined;
}

function eventBookkitBookingId(event: CalEvent): string | undefined {
  return event.bookkitBookingId ?? event.extendedProperties?.private?.bookkitBookingId;
}

function bookingIsActive(
  booking: Pick<Booking, 'status' | 'holdExpiresAt'>,
  now: string | Date,
): boolean {
  if (booking.status === 'confirmed') return true;
  return booking.status === 'hold' && booking.holdExpiresAt !== null && compareInstants(now, booking.holdExpiresAt) <= 0;
}

function overlaps(start: string, end: string, windowStart?: string | Date, windowEnd?: string | Date): boolean {
  if (windowStart && compareInstants(end, windowStart) <= 0) return false;
  if (windowEnd && compareInstants(start, windowEnd) >= 0) return false;
  return true;
}

export function occupancyFor(service: Pick<ServiceConfig, 'occupancyFor'>, quantity: number): number {
  const units = service.occupancyFor ? service.occupancyFor(quantity) : 1;
  if (!Number.isInteger(units) || units < 1) throw new RangeError('occupancyFor must return a positive integer');
  return units;
}

function serviceForBooking(booking: OccupancyBooking, options: OccupancyIntervalOptions): OccupancyService {
  if (!booking.serviceSlug) return options.service;
  const resolver = options.serviceResolver ?? options.resolveService;
  if (resolver) {
    const resolved = resolver(booking.serviceSlug);
    if (!resolved) throw new RangeError(`Unknown occupancy service: ${booking.serviceSlug}`);
    return resolved;
  }
  if (options.services) {
    const resolved = typeof (options.services as ReadonlyMap<string, OccupancyService>).get === 'function'
      ? (options.services as ReadonlyMap<string, OccupancyService>).get(booking.serviceSlug)
      : (options.services as Readonly<Record<string, OccupancyService>>)[booking.serviceSlug];
    if (!resolved) throw new RangeError(`Unknown occupancy service: ${booking.serviceSlug}`);
    return resolved;
  }
  return options.service;
}

export function getOccupancyIntervals(options: OccupancyIntervalOptions): OccupancyInterval[] {
  const now = options.now ?? new Date();
  const intervals: OccupancyInterval[] = [];
  const seenBookingIds = new Set<string>();
  const calendarEventIds = new Set(
    options.bookings.flatMap((booking) => booking.calendarEventId ? [booking.calendarEventId] : []),
  );
  for (const booking of options.bookings) {
    if (seenBookingIds.has(booking.id) || booking.id === options.excludeBookingId || !bookingIsActive(booking, now)) continue;
    seenBookingIds.add(booking.id);
    const bookingService = serviceForBooking(booking, options);
    let start: string;
    let end: string;
    try {
      const startDate = parseUtcInstant(booking.startsAt);
      const endDate = parseUtcInstant(booking.endsAt);
      if (endDate.getTime() <= startDate.getTime()) continue;
      start = startDate.toISOString();
      end = addMinutes(endDate, bookingService.turnaroundMin).toISOString();
      if (parseUtcInstant(end).getTime() <= startDate.getTime()) continue;
    } catch {
      continue;
    }
    if (overlaps(start, end, options.from, options.to)) {
      intervals.push({ start, end, units: occupancyFor(bookingService, booking.quantity), source: 'booking', bookingId: booking.id });
    }
  }
  const seenCalendarEventIds = new Set<string>();
  for (const event of options.calendarEvents ?? []) {
    if (event.allDay || ('date' in (typeof event.start === 'string' ? {} : event.start))) continue;
    const bookkitBookingId = eventBookkitBookingId(event);
    if ((bookkitBookingId && seenBookingIds.has(bookkitBookingId)) || (event.id && calendarEventIds.has(event.id))) continue;
    if (event.id && seenCalendarEventIds.has(event.id)) continue;
    if (event.id) seenCalendarEventIds.add(event.id);
    const start = instantFromValue(event.start);
    const end = instantFromValue(event.end);
    if (!start || !end || compareInstants(end, start) <= 0 || !overlaps(start, end, options.from, options.to)) continue;
    intervals.push({
      start,
      end,
      units: 1,
      source: 'calendar',
      ...(event.id ? { eventId: event.id } : {}),
    });
  }
  return intervals;
}

export const buildOccupancyIntervals = getOccupancyIntervals;

export function resolveCapacity(defaultCapacity: number, override?: Pick<DayCapacityOverride, 'capacity'> | null): number {
  const value = override ? override.capacity : defaultCapacity;
  return Math.max(0, Math.floor(value));
}

// A capacity-level default that applies from a date onwards ("a van is out of service starting
// Aug 10"), until superseded by a later entry. Per-day overrides still trump the result.
export interface CapacityDefault {
  fromDate: string;
  capacity: number;
  reason: string | null;
}

export function defaultCapacityForDate(date: string, baseCapacity: number, defaults: readonly CapacityDefault[]): number {
  let active: CapacityDefault | undefined;
  for (const candidate of defaults) {
    if (candidate.fromDate <= date && (!active || candidate.fromDate > active.fromDate)) active = candidate;
  }
  return active ? resolveCapacity(active.capacity) : resolveCapacity(baseCapacity);
}

export function capacityForDate(
  date: string,
  defaultCapacity: number,
  overrides: readonly DayCapacityOverride[] | ReadonlyMap<string, DayCapacityOverride> = [],
): { capacity: number; closedReason?: string } {
  let override: DayCapacityOverride | undefined;
  if (Array.isArray(overrides)) {
    override = overrides.find((candidate: DayCapacityOverride) => candidate.date === date);
  } else {
    override = (overrides as ReadonlyMap<string, DayCapacityOverride>).get(date);
  }
  const capacity = resolveCapacity(defaultCapacity, override);
  return override?.reason ? { capacity, closedReason: override.reason } : { capacity };
}

function maxAtBoundaries(intervals: readonly OccupancyInterval[], start: string, end: string): number {
  const windowStart = parseUtcInstant(start).getTime();
  const windowEnd = parseUtcInstant(end).getTime();
  if (windowEnd <= windowStart) return 0;
  const validIntervals: Array<{ interval: OccupancyInterval; start: number; end: number }> = [];
  const points = new Set<number>([windowStart, windowEnd]);
  for (const interval of intervals) {
    try {
      const intervalStart = parseUtcInstant(interval.start).getTime();
      const intervalEnd = parseUtcInstant(interval.end).getTime();
      if (intervalEnd <= intervalStart || !Number.isFinite(interval.units) || interval.units <= 0) continue;
      if (intervalEnd <= windowStart || intervalStart >= windowEnd) continue;
      validIntervals.push({ interval, start: intervalStart, end: intervalEnd });
      points.add(Math.max(windowStart, intervalStart));
      points.add(Math.min(windowEnd, intervalEnd));
    } catch {
      continue;
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  let maximum = 0;
  for (const point of sorted.slice(0, -1)) {
    let used = 0;
    for (const candidate of validIntervals) {
      if (candidate.start <= point && candidate.end > point) used += candidate.interval.units;
    }
    maximum = Math.max(maximum, used);
  }
  return maximum;
}

export function maxConcurrentOccupancy(
  intervals: readonly OccupancyInterval[],
  start: string | Date,
  end: string | Date,
): number {
  return maxAtBoundaries(intervals, parseUtcInstant(start).toISOString(), parseUtcInstant(end).toISOString());
}

export function remainingCapacity(
  capacity: number,
  intervals: readonly OccupancyInterval[],
  start: string | Date,
  end: string | Date,
): number {
  return Math.max(0, resolveCapacity(capacity) - maxConcurrentOccupancy(intervals, start, end));
}

export function isSlotAvailable(
  slotStart: string | Date,
  slotEnd: string | Date,
  options: SlotAvailabilityOptions,
): boolean {
  const end = addMinutes(slotEnd, options.turnaroundMin);
  const used = maxConcurrentOccupancy(options.intervals, slotStart, end);
  return used + options.requestedUnits <= resolveCapacity(options.capacity);
}

export function slotRemaining(
  slotStart: string | Date,
  slotEnd: string | Date,
  options: Omit<SlotAvailabilityOptions, 'requestedUnits'>,
): number {
  const end = addMinutes(slotEnd, options.turnaroundMin);
  return remainingCapacity(options.capacity, options.intervals, slotStart, end);
}

// How many more bookings of this party size still fit in the remaining capacity units — a slot with
// 3 units left and a 2-unit party has room for 1 more booking, not 3. occupancyFor always returns
// a positive integer (it throws otherwise), so this never divides by zero.
export function remainingBookings(remainingUnits: number, service: Pick<ServiceConfig, 'occupancyFor'>, quantity: number): number {
  return Math.floor(remainingUnits / occupancyFor(service, quantity));
}

function isWithinRequestWindow(slot: GeneratedSlot, options: DayAvailabilityOptions, now: Date): boolean {
  const start = parseUtcInstant(slot.utcStart);
  const min = options.minNoticeHours === undefined ? now : new Date(now.getTime() + options.minNoticeHours * 3_600_000);
  if (start.getTime() < min.getTime()) return false;
  if (options.maxHorizonDays !== undefined) {
    const max = new Date(now.getTime() + options.maxHorizonDays * 86_400_000);
    if (start.getTime() > max.getTime()) return false;
  }
  return true;
}

export function availabilityForDay(options: DayAvailabilityOptions): DayAvailability {
  if (resolveCapacity(options.capacity) === 0 || !scheduleForDate(options.service, options.date, options.timezone)) {
    return {
      date: options.date,
      status: 'closed',
      ...(options.closedReason ? { closedReason: options.closedReason } : {}),
      slots: [],
    };
  }
  const now = parseUtcInstant(options.now ?? new Date());
  const candidates = generateDaySlots(options);
  const intervals = getOccupancyIntervals({
    bookings: options.bookings,
    ...(options.calendarEvents ? { calendarEvents: options.calendarEvents } : {}),
    service: options.service,
    ...(options.services ? { services: options.services } : {}),
    ...(options.serviceResolver ? { serviceResolver: options.serviceResolver } : {}),
    ...(options.resolveService ? { resolveService: options.resolveService } : {}),
    now,
    ...(options.excludeBookingId ? { excludeBookingId: options.excludeBookingId } : {}),
  });
  const requestedUnits = occupancyFor(options.service, options.requestedQuantity);
  const slots = candidates
    .filter((slot) => isWithinRequestWindow(slot, options, now))
    .map((slot) => ({
      slot,
      remaining: slotRemaining(slot.utcStart, slot.utcEnd, {
        capacity: options.capacity,
        intervals,
        turnaroundMin: options.service.turnaroundMin,
      }),
    }))
    .filter(({ slot, remaining }) => isSlotAvailable(slot.utcStart, slot.utcEnd, {
      capacity: options.capacity,
      intervals,
      requestedUnits,
      turnaroundMin: options.service.turnaroundMin,
    }) && remaining > 0)
    .map(({ slot, remaining }) => ({
      start: slot.start,
      remaining,
      remainingBookings: remainingBookings(remaining, options.service, options.requestedQuantity),
    }));
  const status = slots.length === 0 ? 'full' : slots.length <= options.limitedThreshold ? 'limited' : 'available';
  return { date: options.date, status, slots };
}

function generateDaySlots(options: DayAvailabilityOptions): GeneratedSlot[] {
  return generateSlots(options.service, options.date, options.timezone);
}
