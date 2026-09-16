import type { CheckoutResponse } from '../core/api.js';
import type { Booking } from '../core/booking.js';
import { DEFAULT_TOKEN_EXPIRY_DAYS, pickupOptionFor, resolveLocalizedText, resolveMeetingPoint, resolveService, type MetadataField, type PickupType, type ResolvedServiceConfig } from '../core/config.js';
import { availabilityForDay, capacityForDate, defaultCapacityForDate, occupancyFor } from '../core/occupancy.js';
import { priceFor } from '../core/pricing.js';
import { resolveLocale } from '../core/locale.js';
import { generateReference } from '../core/reference.js';
import { generateSlots } from '../core/slots.js';
import { localDateKey, parseUtcInstant } from '../core/time.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { HoldLimitExceededError, ReferenceConflictError } from '../repo.js';
import { HttpError, json, requestJson, requireInteger, requireString, tokenBytes } from '../http.js';
import { assertSupportedPartySize, calendarEventsForWindow } from './availability.js';
import { run, warnDeprecatedField } from './shared.js';

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
  throw new HttpError(400, 'validation_failed', `${field} must be one of: ${validIds.join(', ')}`, { field, allowed: validIds });
}

// The one priced-amount resolution — quote and checkout both call this, so the quoted price and
// the charged price can never disagree for any (service, quantity, pickup).
export function quotedPriceMinor(service: ResolvedServiceConfig, quantity: number, pickup: PickupType | null, serviceSlug: string): number {
  assertSupportedPartySize(service, quantity);
  try {
    return priceFor(service, quantity, pickup);
  } catch {
    throw new HttpError(
      400,
      'validation_failed',
      `quantity ${quantity} with pickupType ${pickup ?? 'none'} has no pricing rule for service ${serviceSlug}`,
      { field: 'quantity' },
    );
  }
}

// meetingPointId is required exactly when the pickup option's usesMeetingPoint flag is set — not
// merely pickupType === 'default', since e.g. a "custom drop-off" can still use a meeting point.
// Resolves to null/null rather than throwing when the service declares no meeting points at all.
function resolveCheckoutMeetingPoint(
  service: ResolvedServiceConfig,
  pickupType: PickupType,
  body: Record<string, unknown>,
  locales: { locale: string; defaultLocale: string },
): { id: string | null; label: string | null } {
  // The stored label is a point-in-time snapshot shown to this customer, so it is rendered here in
  // the booking's own locale rather than kept as the config's per-locale map.
  const snapshot = (point: { id: string; label: Parameters<typeof resolveLocalizedText>[0] }) =>
    ({ id: point.id, label: resolveLocalizedText(point.label, locales.locale, locales.defaultLocale) });
  const points = service.location?.meetingPoints ?? [];
  const raw = body.meetingPointId;
  if (raw !== undefined) {
    if (points.length === 0) throw new HttpError(400, 'validation_failed', 'This service declares no meeting points; do not send meetingPointId');
    const suppliedId = requireString(raw, 'meetingPointId');
    const point = resolveMeetingPoint(service, suppliedId);
    if (point.id !== suppliedId) {
      const declared = points.map((candidate) => candidate.id);
      throw new HttpError(400, 'validation_failed', `meetingPointId must be one of: ${declared.join(', ')}`, { field: 'meetingPointId', allowed: declared });
    }
    return snapshot(point);
  }
  if (points.length === 0) return { id: null, label: null };
  if (points.length > 1 && pickupOptionFor(service, pickupType)?.usesMeetingPoint) {
    throw new HttpError(400, 'validation_failed', 'meetingPointId is required for a service with more than one meeting point');
  }
  return snapshot(resolveMeetingPoint(service));
}

// Rejects (rather than silently ignores) pickupType/meetingPointId for a location-less service, so
// a client with stale fields (e.g. after an operator drops the location module) gets an actionable
// 400 instead of a booking that silently discarded input.
function resolveCheckoutLocation(
  context: ReservaContext,
  service: ResolvedServiceConfig,
  body: Record<string, unknown>,
  locale: string,
): CheckoutLocation {
  // `pickup` is the one spelling; `pickupType` still reads so a consumer can upgrade on its own
  // schedule, and says so once per isolate in the log.
  const legacyPickup = body.pickup === undefined ? body.pickupType : undefined;
  if (legacyPickup !== undefined) warnDeprecatedField(context, 'checkout', 'pickupType');
  const pickupType = resolvePickupAxis(service, body.pickup ?? legacyPickup, 'pickup');
  if (pickupType === null) {
    if (body.meetingPointId !== undefined) throw new HttpError(400, 'validation_failed', 'This service has no location module; do not send meetingPointId');
    return { pickupType: null, meetingPointId: null, meetingPointLabel: null };
  }
  const meetingPoint = resolveCheckoutMeetingPoint(service, pickupType, body, { locale, defaultLocale: context.config.locales.default });
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
  if (!validValues.includes(raw)) {
    throw new HttpError(
      400,
      'validation_failed',
      `metadata.${field.key} must be one of: ${validValues.join(', ')} (declared type: select)`,
      { field: `metadata.${field.key}`, allowed: validValues },
    );
  }
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
    if (!context.config.services[serviceSlug]) {
      const declared = Object.keys(context.config.services);
      throw new HttpError(400, 'validation_failed', `serviceSlug must be one of: ${declared.join(', ')}`, { field: 'serviceSlug', allowed: declared });
    }
    const start = requireString(body.start, 'start');
    const quantity = requireInteger(body.quantity, 'quantity');
    // resolveService is a cheap lookup, already needed below for assertSupportedPartySize — pulled
    // forward here since resolveCheckoutLocation also needs it to validate pickupType.
    const service = resolveService(context.config, serviceSlug);
    // Resolved before the location: the meeting-point label snapshot stored on the booking is
    // rendered in this locale.
    // A bare or regional variant tag negotiates onto a supported locale (`pt` -> `pt-PT`) instead of
    // being rejected, so only what the deployment supports is ever stored on the booking.
    const locale = resolveLocale(context.config.locales, requireString(body.locale, 'locale'));
    const location = resolveCheckoutLocation(context, service, body, locale);
    const metadata = validateCheckoutMetadata(service, serviceSlug, body.metadata);
    const now = nowIso(context);
    const candidate = await checkSlot(context, serviceSlug, quantity, start, now);
    const priceMinor = quotedPriceMinor(candidate.service, quantity, location.pickupType, serviceSlug);
    const year = Number(localDateKey(candidate.startsAt, context.config.business.timezone).slice(0, 4));
    const prefix = `${context.config.business.shortCode.toUpperCase()}-${year}-`;
    // No per-candidate pre-read: the insert's ON CONFLICT(reference) is the authority, and a
    // collision comes back as ReferenceConflictError for the retry below to regenerate against.
    let sequence = await context.repo.countReferencesForYear(prefix) + 1;
    let referenceAttempts = 0;
    // checkSlot above is only a fast-path pre-check (TOCTOU — two concurrent checkouts can both pass
    // it for the last unit). insertHoldWithCapacity is the authority: it re-evaluates capacity inside
    // the same atomic INSERT ... SELECT ... WHERE, so only one concurrent request can win the last unit.
    const occupancyUnits = occupancyFor(candidate.service, quantity);
    const occupancyEndsAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.service.turnaroundMin * 60_000).toISOString();
    const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
    let booking: Booking | null = null;
    let sweptForCapacity = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reference = generateReference(context.config.business.shortCode, year, sequence);
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
        if (!created) {
          // The only sweep left on this path, and deliberately unthrottled: a hold that expired
          // seconds ago still occupies the unit the customer is paying for, so free it and retry
          // once before telling them the slot is gone.
          if (sweptForCapacity) throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
          sweptForCapacity = true;
          await context.repo.sweepExpiredHolds(now);
          continue;
        }
        booking = created;
        break;
      } catch (error) {
        if (error instanceof HoldLimitExceededError) {
          throw new HttpError(429, 'too_many_holds', error.message);
        }
        if (error instanceof HttpError) throw error;
        // A taken reference is the one retryable insert failure: regenerate and try again, up to
        // five times, then give up rather than loop on a sequence that keeps colliding.
        if (!(error instanceof ReferenceConflictError)) throw error;
        referenceAttempts += 1;
        if (referenceAttempts >= 5) throw error;
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
      return json<CheckoutResponse>({
        checkoutUrl: checkout.url,
        bookingId: booking.id,
        reference: booking.reference,
        // The provider's own page deadline where it publishes one; otherwise the hold expiry, which
        // is the moment the slot is released either way.
        paymentDeadline: checkout.expiresAt ?? booking.holdExpiresAt ?? nowIso(context),
      }, 201);
    } catch (error) {
      await context.repo.expireHold(booking.id, nowIso(context)).catch(() => undefined);
      throw error;
    }
  });
}
