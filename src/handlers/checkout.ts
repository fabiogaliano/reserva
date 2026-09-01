import type { CheckoutResponse } from '../core/api';
import type { Booking } from '../core/booking';
import { DEFAULT_TOKEN_EXPIRY_DAYS, pickupOptionFor, resolveMeetingPoint, resolveService, type MetadataField, type PickupType, type ServiceConfig } from '../core/config';
import { availabilityForDay, capacityForDate, defaultCapacityForDate, occupancyFor } from '../core/occupancy';
import { priceFor } from '../core/pricing';
import { resolveLocale } from '../core/locale';
import { generateUniqueReference } from '../core/reference';
import { generateSlots } from '../core/slots';
import { localDateKey, parseUtcInstant } from '../core/time';
import type { BookkitContext } from '../context';
import { nowIso } from '../context';
import { HoldLimitExceededError } from '../repo';
import { HttpError, json, requestJson, requireInteger, requireString, tokenBytes } from '../http';
import { assertSupportedPartySize, calendarEventsForWindow } from './availability';
import { run } from './shared';

// Plan 023 (design decision 3): a service with no location module has no pickup axis to validate
// against, so the checkout body must not carry pickupType/meetingPointId at all — the 400 names
// what to remove rather than guessing at a value. A location-ful service validates the supplied
// value against its own declared option ids (via pickupOptionFor); the 400 names the valid ids so
// a client with a stale option list gets an actionable error.
interface CheckoutLocation { pickupType: PickupType | null; meetingPointId: string | null; meetingPointLabel: string | null }

// Plan 027 (design decision 1 / STOP condition 2): the ONE pickup-axis validation, shared verbatim
// by checkout (whose body field is `pickupType`) and quote (whose field is `pickup`) — the field
// name is a parameter precisely so neither endpoint can grow a second, divergent rule about which
// pickup ids are acceptable. A location-less service rejects the field outright; a location-ful one
// requires an id it actually declares, and the 400 lists them so a client with a stale option list
// can correct itself.
export function resolvePickupAxis(service: ServiceConfig, value: unknown, field: string): PickupType | null {
  if (!service.location) {
    if (value !== undefined) throw new HttpError(400, 'validation_failed', `This service has no location module; do not send ${field}`);
    return null;
  }
  if (typeof value === 'string' && pickupOptionFor(service, value)) return value;
  const validIds = service.location.pickupOptions.map((option) => option.id);
  requireString(value, field);
  throw new HttpError(400, 'validation_failed', `${field} must be one of: ${validIds.join(', ')}`);
}

// Plan 027 (design decision 1 / STOP condition 2): the ONE priced-amount resolution. Quote returns
// exactly this number and checkout charges exactly this number, from the same call, so the two can
// never disagree for any (service, quantity, pickup).
export function quotedPriceMinor(service: ServiceConfig, quantity: number, pickup: PickupType | null): number {
  assertSupportedPartySize(service, quantity);
  try {
    return priceFor(service, quantity, pickup);
  } catch {
    throw new HttpError(400, 'validation_failed', 'No price is configured for this party and pickup type');
  }
}

// Plan 017 (design decision 2): meetingPointId is optional on the wire but the RESOLVED id is
// always what gets stored, so downstream rendering (bookingSummary/confirmationSummary, admin,
// providers) never has to branch on "absent" — only ever on a stored id that's since been
// removed from config (meetingPointForBooking's fallback).
//
// Plan 018 (design decision 6): required onto the chosen option's usesMeetingPoint rather than
// `pickupType === 'default'` — Maze's "custom drop-off" option still starts at a meeting point
// (usesMeetingPoint: true) even though it also collects an address, so it must still require the
// choice on a multi-point service; an option with usesMeetingPoint: false accepts-but-doesn't-require
// a supplied id, exactly like 'custom' did before this plan. `pickupType` here has already been
// validated by parsePickup against this same service, so the option is always declared.
//
// Plan 023 (design decision 1): a location-ful service need not declare any meeting points at all
// (every pickup option can have usesMeetingPoint: false) — that resolves to { id: null, label:
// null } rather than throwing, since resolveMeetingPoint's "declares no meeting points" error is
// reserved for a genuinely invalid request (a supplied meetingPointId with none to match).
function resolveCheckoutMeetingPoint(service: ServiceConfig, pickupType: PickupType, body: Record<string, unknown>): { id: string | null; label: string | null } {
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

// Plan 023 (design decision 3): the checkout body must not carry pickupType/meetingPointId for a
// location-less service — rejecting them here (rather than silently ignoring) means a client that
// still sends stale fields (e.g. after an operator drops a service's location module) gets an
// actionable 400 instead of a booking that silently discarded its input.
function resolveCheckoutLocation(service: ServiceConfig, body: Record<string, unknown>): CheckoutLocation {
  const pickupType = resolvePickupAxis(service, body.pickupType, 'pickupType');
  if (pickupType === null) {
    if (body.meetingPointId !== undefined) throw new HttpError(400, 'validation_failed', 'This service has no location module; do not send meetingPointId');
    return { pickupType: null, meetingPointId: null, meetingPointLabel: null };
  }
  const meetingPoint = resolveCheckoutMeetingPoint(service, pickupType, body);
  return { pickupType, meetingPointId: meetingPoint.id, meetingPointLabel: meetingPoint.label };
}

// Plan 024 (design decision 2): the whole 8 KB cap is on the SERIALIZED result, checked once after
// every field has been validated/coerced — a per-field maxLength (text only) bounds individual
// values, but the object as a whole still needs its own ceiling.
const METADATA_MAX_SERIALIZED_BYTES = 8 * 1024;
const DEFAULT_METADATA_TEXT_MAX_LENGTH = 500;

// Plan 024 (design decision 2): strict coercion — no `"true"` -> boolean, no `"5"` -> number.
// Every throw names the offending key, its declared type, and the violated constraint, so the
// caller can correct the request from the envelope alone (direction doc §8, remediating errors).
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

// Plan 024 (design decision 2): unknown keys rejected, `required` enforced, strict type coercion,
// the whole serialized result capped at 8 KB, and a service with no declaration rejects any
// non-empty metadata object — every branch names what was wrong and what to send instead. Returns
// null (not `{}`) for "nothing to store", matching every pre-024 row and repo.ts's own
// serializeBookingMetadata symmetry.
function validateCheckoutMetadata(service: ServiceConfig, serviceSlug: string, raw: unknown): Record<string, unknown> | null {
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

function assertSlot(config: BookkitContext['config'], serviceSlug: string, start: string, now: string): { service: ReturnType<typeof resolveService>; startsAt: string; endsAt: string } {
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
  context: BookkitContext,
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

export function handleCheckout(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const serviceSlug = requireString(body.serviceSlug, 'serviceSlug');
    if (!context.config.services[serviceSlug]) throw new HttpError(400, 'validation_failed', 'Unknown service');
    const start = requireString(body.start, 'start');
    const quantity = requireInteger(body.quantity, 'quantity');
    // Plan 018 (design decision 6): resolveService is a cheap in-memory lookup (already needed below
    // for assertSupportedPartySize), so it's pulled forward here rather than duplicated — parsePickup
    // needs the service itself to validate pickupType against its declared option ids.
    const service = resolveService(context.config, serviceSlug);
    const location = resolveCheckoutLocation(service, body);
    const metadata = validateCheckoutMetadata(service, serviceSlug, body.metadata);
    // Plan 027 (design decision 5): a bare or regional variant tag negotiates onto a supported
    // locale (`pt` -> `pt-PT`) instead of being rejected; only what the deployment actually
    // supports is ever stored on the booking, so emails and pages have a catalog for it.
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
    // BK-CAP-001 / AR-001: checkSlot above is only a fast-path pre-check (read-then-write TOCTOU
    // — two concurrent checkouts can both pass it for the same last unit). insertHoldWithCapacity
    // is the authority: it re-evaluates occupied-units-in-interval + requested <= capacity inside
    // the same atomic INSERT ... SELECT ... WHERE as the write itself, so only one concurrent
    // request for the last unit can ever succeed.
    const occupancyUnits = occupancyFor(candidate.service, quantity);
    const occupancyEndsAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.service.turnaroundMin * 60_000).toISOString();
    const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
    let booking: Booking | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reference = await generateUniqueReference(context.config.business.shortCode, year, sequence, referenceExists);
      try {
        const holdLimit = context.config.booking.maxHoldsPerIp;
        // BK-SEC-002: expiry counts from the service's end, not from creation, so the link keeps
        // working through the whole pre-service period plus a post-service grace window — see
        // ClientConfig.booking.tokenExpiryDays (src/core/config.ts).
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
      // BK-PAY-002: the idempotency key createCheckout derives is scoped to this hold, not this
      // request, so it's fine to expire the hold below on any failure here (a provider rejection, a
      // missing checkout URL, or the updateBooking write) rather than distinguish them. If the
      // *whole* POST is retried by the client after a 5xx, this path mints a fresh hold (and thus a
      // fresh key) rather than reusing this one; that's fine because the idempotency key only needs
      // to prevent a duplicate payable session per hold, not across holds — this hold's now-expired
      // row and any session the provider did create for it still resolve via the late-webhook
      // backfill path (getBookingBySessionRef / metadata.bookingId), same as before this fix.
      const checkout = await context.providers.payments.createCheckout(booking, context.config, context.routeConfig.paths);
      await context.repo.updateBooking(booking.id, { paymentSessionRef: checkout.sessionRef, updatedAt: nowIso(context) });
      return json<CheckoutResponse>({ checkoutUrl: checkout.url, bookingId: booking.id, reference: booking.reference }, 201);
    } catch (error) {
      await context.repo.expireHold(booking.id, nowIso(context)).catch(() => undefined);
      throw error;
    }
  });
}
