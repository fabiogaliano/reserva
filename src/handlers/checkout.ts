import type { CheckoutResponse } from '../core/api.js';
import type { Booking } from '../core/booking.js';
import { DEFAULT_TOKEN_EXPIRY_DAYS, pickupOptionFor, resolveMeetingPoint, resolveService, type MetadataField, type PickupType, type ResolvedServiceConfig } from '../core/config.js';
import { availabilityForDay, capacityForDate, defaultCapacityForDate, occupancyFor } from '../core/occupancy.js';
import { priceFor } from '../core/pricing.js';
import { resolveLocale } from '../core/locale.js';
import { generateUniqueReference } from '../core/reference.js';
import { generateSlots } from '../core/slots.js';
import { localDateKey, parseUtcInstant } from '../core/time.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { HoldLimitExceededError } from '../repo.js';
import { HttpError, json, requestJson, requireInteger, requireString, tokenBytes } from '../http.js';
import { assertSupportedPartySize, calendarEventsForWindow } from './availability.js';
import { run } from './shared.js';

// A location-less service must not receive pickupType/meetingPointId at all — the 400 names what
// to remove. A location-ful service validates the value against its declared option ids; the 400
// lists them so a client with a stale option list gets an actionable error.
interface CheckoutLocation { pickupType: PickupType | null; meetingPointId: string | null; meetingPointLabel: string | null }

// The one pickup-axis validation, shared by checkout (`pickupType`) and quote (`pickup`) via a
// parameterized field name, so neither endpoint can grow a divergent rule about valid pickup ids.
export function resolvePickupAxis(service: ResolvedServiceConfig, value: unknown, field: string): PickupType | null {
  if (!service.location) {
    if (value !== undefined) throw new HttpError(400, 'validation_failed', `This service has no location module; do not send ${field}`);
    return null;
  }
  if (typeof value === 'string' && pickupOptionFor(service, value)) return value;
  const validIds = service.location.pickupOptions.map((option) => option.id);
  requireString(value, field);
  throw new HttpError(400, 'validation_failed', `${field} must be one of: ${validIds.join(', ')}`);
}

// The one priced-amount resolution — quote and checkout both call this, so the quoted price and
// the charged price can never disagree for any (service, quantity, pickup).
export function quotedPriceMinor(service: ResolvedServiceConfig, quantity: number, pickup: PickupType | null): number {
  assertSupportedPartySize(service, quantity);
  try {
    return priceFor(service, quantity, pickup);
  } catch {
    throw new HttpError(400, 'validation_failed', 'No price is configured for this party and pickup type');
  }
}

// meetingPointId is required exactly when the pickup option's usesMeetingPoint flag is set — not
// merely pickupType === 'default', since e.g. a "custom drop-off" can still use a meeting point.
// Resolves to null/null rather than throwing when the service declares no meeting points at all.
function resolveCheckoutMeetingPoint(service: ResolvedServiceConfig, pickupType: PickupType, body: Record<string, unknown>): { id: string | null; label: string | null } {
  const points = service.location?.meetingPoints ?? [];
  const raw = body.meetingPointId;
  if (raw !== undefined) {
    if (points.length === 0) throw new HttpError(400, 'validation_failed', 'This service declares no meeting points; do not send meetingPointId');
    const suppliedId = requireString(raw, 'meetingPointId');
    const point = resolveMeetingPoint(service, suppliedId);
    if (point.id !== suppliedId) throw new HttpError(400, 'validation_failed', 'Unknown meetingPointId');
    return point;
  }
  if (points.length === 0) return { id: null, label: null };
  if (points.length > 1 && pickupOptionFor(service, pickupType)?.usesMeetingPoint) {
    throw new HttpError(400, 'validation_failed', 'meetingPointId is required for a service with more than one meeting point');
  }
  return resolveMeetingPoint(service);
}

// Rejects (rather than silently ignores) pickupType/meetingPointId for a location-less service, so
// a client with stale fields (e.g. after an operator drops the location module) gets an actionable
// 400 instead of a booking that silently discarded input.
function resolveCheckoutLocation(service: ResolvedServiceConfig, body: Record<string, unknown>): CheckoutLocation {
  const pickupType = resolvePickupAxis(service, body.pickupType, 'pickupType');
  if (pickupType === null) {
    if (body.meetingPointId !== undefined) throw new HttpError(400, 'validation_failed', 'This service has no location module; do not send meetingPointId');
    return { pickupType: null, meetingPointId: null, meetingPointLabel: null };
  }
  const meetingPoint = resolveCheckoutMeetingPoint(service, pickupType, body);
  return { pickupType, meetingPointId: meetingPoint.id, meetingPointLabel: meetingPoint.label };
}

// The 8 KB cap is on the SERIALIZED result, checked once after every field is validated/coerced —
// per-field maxLength bounds individual text values, but the object as a whole needs its own ceiling.
const METADATA_MAX_SERIALIZED_BYTES = 8 * 1024;
const DEFAULT_METADATA_TEXT_MAX_LENGTH = 500;

// Strict coercion — no `"true"` -> boolean, no `"5"` -> number.
// Every throw names the offending key, its declared type, and the violated constraint, so the
// caller can correct the request from the envelope alone.
function coerceMetadataValue(field: MetadataField, raw: unknown): string | number | boolean {
  if (field.type === 'text') {
    if (typeof raw !== 'string') throw new HttpError(400, 'validation_failed', `metadata.${field.key} must be a string (declared type: text)`);
    const maxLength = field.maxLength ?? DEFAULT_METADATA_TEXT_MAX_LENGTH;
    if (raw.length > maxLength) throw new HttpError(400, 'validation_failed', `metadata.${field.key} must be at most ${maxLength} characters (declared type: text)`);
    return raw;
  }
  if (field.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new HttpError(400, 'validation_failed', `metadata.${field.key} must be a number (declared type: number)`);
    return raw;
  }
  if (field.type === 'boolean') {
    if (typeof raw !== 'boolean') throw new HttpError(400, 'validation_failed', `metadata.${field.key} must be a boolean (declared type: boolean); it was not strictly coerced from another type`);
    return raw;
  }
  // 'select'
  if (typeof raw !== 'string') throw new HttpError(400, 'validation_failed', `metadata.${field.key} must be a string matching one of its declared options (declared type: select)`);
  const validValues = (field.options ?? []).map((option) => option.value);
  if (!validValues.includes(raw)) throw new HttpError(400, 'validation_failed', `metadata.${field.key} must be one of: ${validValues.join(', ')} (declared type: select)`);
  return raw;
}

// Returns null (not `{}`) for "nothing to store", matching every existing row and
// serializeBookingMetadata's own symmetry.
function validateCheckoutMetadata(service: ResolvedServiceConfig, serviceSlug: string, raw: unknown): Record<string, unknown> | null {
  const value = raw === undefined ? {} : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'validation_failed', 'metadata must be an object');
  }
  const input = value as Record<string, unknown>;
  const fields = service.metadataFields ?? [];
  if (fields.length === 0) {
    if (Object.keys(input).length > 0) {
      throw new HttpError(400, 'validation_failed', `service ${serviceSlug} declares no metadata fields; do not send metadata`);
    }
    return null;
  }
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(input)) {
    if (!fieldByKey.has(key)) {
      throw new HttpError(400, 'validation_failed', `metadata.${key} is not a declared field for service ${serviceSlug}; declared keys: ${fields.map((field) => field.key).join(', ')}`);
    }
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, field.key)) {
      if (field.required) throw new HttpError(400, 'validation_failed', `metadata.${field.key} is required (declared type: ${field.type})`);
      continue;
    }
    result[field.key] = coerceMetadataValue(field, input[field.key]);
  }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(result)).length;
  if (serializedBytes > METADATA_MAX_SERIALIZED_BYTES) {
    throw new HttpError(400, 'validation_failed', `metadata is ${serializedBytes} bytes serialized, over the ${METADATA_MAX_SERIALIZED_BYTES} byte limit; remove or shorten some fields`);
  }
  return Object.keys(result).length > 0 ? result : null;
}

function assertSlot(config: ReservaContext['config'], serviceSlug: string, start: string, now: string): { service: ReturnType<typeof resolveService>; startsAt: string; endsAt: string } {
  const service = resolveService(config, serviceSlug);
  let instant: Date;
  try {
    instant = parseUtcInstant(start);
  } catch {
    throw new HttpError(400, 'validation_failed', 'start must be an ISO 8601 instant with an explicit offset');
  }
  const localDate = localDateKey(instant, config.business.timezone);
  const slot = generateSlots(service, localDate, config.business.timezone).find((candidate) => parseUtcInstant(candidate.utcStart).getTime() === instant.getTime());
  if (!slot) throw new HttpError(409, 'slot_unavailable', 'The selected slot is not available');
  if (instant.getTime() < parseUtcInstant(now).getTime() + config.booking.minNoticeHours * 3_600_000) {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  }
  if (instant.getTime() > parseUtcInstant(now).getTime() + config.booking.maxHorizonDays * 86_400_000) {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is outside the booking horizon');
  }
  return { service, startsAt: slot.utcStart, endsAt: slot.utcEnd };
}

export async function checkSlot(
  context: ReservaContext,
  serviceSlug: string,
  quantity: number,
  start: string,
  now: string,
  excludeBookingId?: string,
): Promise<{ service: ReturnType<typeof resolveService>; startsAt: string; endsAt: string }> {
  const candidate = assertSlot(context.config, serviceSlug, start, now);
  const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
  const override = await context.repo.getDayOverride(localDate);
  const capacityDefaults = await context.repo.listCapacityDefaults();
  const lookback = Math.max(
    ...Object.values(context.config.services).map((service) => service.durationMin + service.turnaroundMin),
  );
  const windowStart = new Date(parseUtcInstant(candidate.startsAt).getTime() - lookback * 60_000).toISOString();
  const windowEnd = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.service.turnaroundMin * 60_000).toISOString();
  const bookings = await context.repo.listOccupancyBookings(windowStart, windowEnd);
  const { events: calendarEvents } = await calendarEventsForWindow(context, windowStart, windowEnd, now);
  const day = availabilityForDay({
    date: localDate,
    timezone: context.config.business.timezone,
    service: candidate.service,
    capacity: capacityForDate(localDate, defaultCapacityForDate(localDate, context.config.capacity.default, capacityDefaults), override ? [override] : []).capacity,
    bookings,
    calendarEvents,
    services: context.config.services,
    requestedQuantity: quantity,
    now,
    minNoticeHours: context.config.booking.minNoticeHours,
    maxHorizonDays: context.config.booking.maxHorizonDays,
    limitedThreshold: context.config.booking.limitedThreshold,
    ...(excludeBookingId ? { excludeBookingId } : {}),
  });
  const available = day.slots.some((slot) => parseUtcInstant(slot.start).getTime() === parseUtcInstant(candidate.startsAt).getTime());
  if (!available) throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  return candidate;
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function handleCheckout(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const serviceSlug = requireString(body.serviceSlug, 'serviceSlug');
    if (!context.config.services[serviceSlug]) throw new HttpError(400, 'validation_failed', 'Unknown service');
    const start = requireString(body.start, 'start');
    const quantity = requireInteger(body.quantity, 'quantity');
    // resolveService is a cheap lookup, already needed below for assertSupportedPartySize — pulled
    // forward here since resolveCheckoutLocation also needs it to validate pickupType.
    const service = resolveService(context.config, serviceSlug);
    const location = resolveCheckoutLocation(service, body);
    const metadata = validateCheckoutMetadata(service, serviceSlug, body.metadata);
    // A bare or regional variant tag negotiates onto a supported locale (`pt` -> `pt-PT`) instead of
    // being rejected, so only what the deployment supports is ever stored on the booking.
    const locale = resolveLocale(context.config.locales, requireString(body.locale, 'locale'));
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    const candidate = await checkSlot(context, serviceSlug, quantity, start, now);
    const priceMinor = quotedPriceMinor(candidate.service, quantity, location.pickupType);
    const year = Number(localDateKey(candidate.startsAt, context.config.business.timezone).slice(0, 4));
    const prefix = `${context.config.business.shortCode.toUpperCase()}-${year}-`;
    const referenceExists = async (candidateReference: string): Promise<boolean> =>
      (await context.repo.getBookingByReference(candidateReference)) !== null;
    let sequence = await context.repo.countReferencesForYear(prefix) + 1;
    // checkSlot above is only a fast-path pre-check (TOCTOU — two concurrent checkouts can both pass
    // it for the last unit). insertHoldWithCapacity is the authority: it re-evaluates capacity inside
    // the same atomic INSERT ... SELECT ... WHERE, so only one concurrent request can win the last unit.
    const occupancyUnits = occupancyFor(candidate.service, quantity);
    const occupancyEndsAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.service.turnaroundMin * 60_000).toISOString();
    const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
    let booking: Booking | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reference = await generateUniqueReference(context.config.business.shortCode, year, sequence, referenceExists);
      try {
        const holdLimit = context.config.booking.maxHoldsPerIp;
        // Expiry counts from the service's end, not from creation, so the link keeps working through
        // the whole pre-service period plus a post-service grace window.
        const tokenExpiryDays = context.config.booking.tokenExpiryDays ?? DEFAULT_TOKEN_EXPIRY_DAYS;
        const tokensExpireAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + tokenExpiryDays * 86_400_000).toISOString();
        const created = await context.repo.insertHoldWithCapacity({
          id: crypto.randomUUID(), reference, serviceSlug, quantity, pickupType: location.pickupType,
          meetingPointId: location.meetingPointId, meetingPointLabel: location.meetingPointLabel,
          startsAt: candidate.startsAt, endsAt: candidate.endsAt, locale, priceMinor, metadata,
          currency: context.config.business.currency,
          holdExpiresAt: new Date(parseUtcInstant(now).getTime() + context.config.booking.holdMinutes * 60_000).toISOString(),
          cancelToken: tokenBytes(), operatorToken: tokenBytes(), createdAt: now, updatedAt: now,
          tokensExpireAt,
          occupancyUnits, occupancyEndsAt, localDate, defaultCapacity: context.config.capacity.default,
          ...(holdLimit ? { holdIp: clientIp(request), maxActiveHoldsForIp: holdLimit } : {}),
        });
        if (!created) throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
        booking = created;
        break;
      } catch (error) {
        if (error instanceof HoldLimitExceededError) {
          throw new HttpError(429, 'too_many_holds', error.message);
        }
        if (error instanceof HttpError) throw error;
        // Classify the insert failure by re-checking the DB rather than parsing the error
        // message: the table has other UNIQUE columns, so message-sniffing could misfire.
        if (attempt === 11 || !(await referenceExists(reference))) throw error;
        sequence += Math.floor(Math.random() * 5) + 1;
      }
    }
    if (!booking) throw new Error('Unable to create booking hold');
    try {
      // The idempotency key is scoped to this hold, not this request, so any failure here can just
      // expire the hold rather than distinguish causes. A client retry after a 5xx mints a fresh hold
      // and key; the abandoned hold's session, if any, still resolves via the late-webhook backfill.
      const checkout = await context.providers.payments.createCheckout(booking, context.config, context.routeConfig.paths);
      await context.repo.updateBooking(booking.id, { paymentSessionRef: checkout.sessionRef, updatedAt: nowIso(context) });
      return json<CheckoutResponse>({ checkoutUrl: checkout.url, bookingId: booking.id, reference: booking.reference }, 201);
    } catch (error) {
      await context.repo.expireHold(booking.id, nowIso(context)).catch(() => undefined);
      throw error;
    }
  });
}
