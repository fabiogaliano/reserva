// The HTTP contract in one place: every handler response type and error envelope, exported from
// `@reservajs/astro/core` so a consumer's client types match the handlers exactly.
import type { WireBooking } from './booking.js';
import type { MetadataField } from './config.js';
// Type-only import: no runtime dependency on the repository. Keeps the outbox family union
// single-sourced from `SIDE_EFFECT_FAMILIES` instead of restating it here.
import type { SideEffectFamily } from '../repo.js';

// The closed set of `error.code` values, as a runtime array so the union type derives from it and
// an unlisted code fails to compile. Add new codes only here — never a separate enum or schema.
export const API_ERROR_CODES = [
  // Request shape rejected: invalid body/query, oversized payload, or wrong method.
  // `validation_failed` messages always name the offending field and rule.
  'validation_failed',
  'method_not_allowed',
  'payload_too_large',
  // Missing, expired, or invalid credential: booking token, operator secret, or admin identity.
  'forbidden',
  'not_found',
  // Understood action that the booking's state or the clock forbids.
  'past_cutoff',
  'invalid_transition',
  'slot_unavailable',
  'too_many_holds',
  // Payment verification failures: session doesn't match the booking, webhook signature invalid,
  // or payment reference already confirmed a different booking.
  'payment_session_mismatch',
  'payment_amount_mismatch',
  'invalid_payment_signature',
  'duplicate_payment_ref',
  // Another request holds this booking's confirmation lease; retry.
  'confirmation_in_progress',
  // Refund failures: conflicting decision, no payment reference to refund, or provider rejection.
  'refund_conflict',
  'refund_payment_ref_missing',
  'refund_failed',
  // An upstream the request needed is temporarily unavailable.
  'calendar_unavailable',
  // Catch-all for an unclassified server fault.
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

// The one failure shape every endpoint returns, at every status code.
export interface ApiErrorEnvelope {
  error: { code: ApiErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// GET /api/booking/availability
// ---------------------------------------------------------------------------

// `remaining` counts further bookings of the requested quantity that fit; `null` above
// `limitedThreshold` (exact capacity stays private). Full slots are omitted, so never 0.
export interface AvailabilitySlot {
  start: string;
  remaining: number | null;
}

export type AvailabilityDayStatus = 'available' | 'limited' | 'full' | 'closed';

export interface AvailabilityDay {
  date: string;
  status: AvailabilityDayStatus;
  // The operator's reason for a capacity override that closed the day; `null` when there is none.
  closedReason: string | null;
  slots: AvailabilitySlot[];
}

export interface AvailabilityResponse {
  timezone: string;
  // Threshold behind `remaining` and the `limited` status, published so consumers don't guess it.
  limitedThreshold: number;
  days: AvailabilityDay[];
}

// ---------------------------------------------------------------------------
// POST /api/booking/quote
// ---------------------------------------------------------------------------

// The pricing authority. `pickup` is required exactly when the service declares a location
// module — the same rule checkout applies to `pickupType`.
export interface QuoteRequest {
  serviceSlug: string;
  quantity: number;
  pickup?: string;
  // Accepted for payload-builder parity with checkout; unused because price never varies by locale.
  locale?: string;
}

export interface QuoteResponse {
  priceMinor: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// POST /api/booking/checkout
// ---------------------------------------------------------------------------

export interface CheckoutRequest {
  serviceSlug: string;
  // An ISO 8601 instant with an explicit offset, matching a generated slot start.
  start: string;
  quantity: number;
  locale: string;
  // Location module: both rejected outright for a service that declares no location.
  pickupType?: string;
  meetingPointId?: string;
  // Consumer-declared fields, validated against the service's own declarations.
  metadata?: Record<string, unknown>;
}

export interface CheckoutResponse {
  checkoutUrl: string;
  bookingId: string;
  reference: string;
}

// ---------------------------------------------------------------------------
// Booking-bearing payloads (GET /api/booking/status, GET /api/booking/manage)
// ---------------------------------------------------------------------------

// Presentation fields layered on the canonical projection: local start/end (vs `WireBooking`'s
// UTC), and metadata rows resolved to display labels — `WireBooking.metadata` stays the raw truth.
export interface WireMeetingPoint {
  label: string;
  mapsUrl: string | null;
}

export interface WireMetadataRow {
  key: string;
  label: string;
  value: string | number | boolean;
}

// Picked from `WireBooking` so a projection change breaks this at compile time. Reachable by
// anyone holding the payment session id, so it excludes contact details, ids, and tokens.
export interface ConfirmationBooking extends Pick<WireBooking, 'reference' | 'serviceSlug' | 'quantity' | 'priceMinor' | 'currency' | 'locale'> {
  start: string;
  end: string;
  meetingPoint: WireMeetingPoint | null;
  metadataRows: WireMetadataRow[];
}

export type StatusState = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'not_found';

export interface StatusResponse {
  status: StatusState;
  booking: ConfirmationBooking | null;
}

// Reached only with the booking's cancel/operator token, so it can carry the full customer record.
export interface ManageBooking extends Pick<
  WireBooking,
  'reference' | 'serviceSlug' | 'quantity' | 'priceMinor' | 'currency' | 'locale' | 'status'
  | 'pickupType' | 'pickupAddress' | 'metadata'
  | 'customerName' | 'customerEmail' | 'customerPhone'
> {
  start: string;
  end: string;
  // Always-present-nullable convention: `null` for a booking with no location data.
  pickupRequiresAddress: boolean | null;
  pickupUsesMeetingPoint: boolean | null;
  meetingPoint: WireMeetingPoint | null;
  metadataRows: WireMetadataRow[];
}

export type ManageRole = 'customer' | 'operator';

export interface ManageResponse {
  booking: ManageBooking;
  role: ManageRole;
  canCancel: boolean;
  canReschedule: boolean;
  canNoShow: boolean;
  // When the customer cancellation cutoff falls, as a UTC instant.
  deadline: string;
}

// Every mutation answers with the same ack; the new state is read back via GET .../manage (or a
// booking event), so this response never becomes a second source of truth.
export interface ManageActionResponse {
  ok: true;
}

export interface ManageActionResponses {
  cancel: ManageActionResponse;
  reschedule: ManageActionResponse;
  noShow: ManageActionResponse;
}

// ---------------------------------------------------------------------------
// GET /api/booking/catalog
// ---------------------------------------------------------------------------

export type MetadataFieldType = MetadataField['type'];

export interface CatalogMeetingPoint {
  id: string;
  label: string;
  mapsUrl: string;
}

export interface CatalogPickupOption {
  id: string;
  label: string;
  hint: string | null;
  requiresAddress: boolean;
  usesMeetingPoint: boolean;
}

export interface CatalogLocation {
  meetingPoints: CatalogMeetingPoint[];
  pickupOptions: CatalogPickupOption[];
}

export interface CatalogMetadataFieldOption {
  value: string;
  label: string;
}

export interface CatalogMetadataField {
  key: string;
  label: string;
  type: MetadataFieldType;
  // Empty for every type but `select`.
  options: CatalogMetadataFieldOption[];
  required: boolean;
  maxLength: number | null;
}

// Everything a consumer needs before a date is chosen. Excludes schedule, pricing, capacity, and
// occupancy — those live in the quote and availability endpoints.
export interface CatalogService {
  slug: string;
  title: string;
  durationMin: number;
  location: CatalogLocation | null;
  metadataFields: CatalogMetadataField[];
}

export interface CatalogResponse {
  services: CatalogService[];
  locales: { supported: string[]; default: string };
  currency: string;
  maxHorizonDays: number;
}

// ---------------------------------------------------------------------------
// GET /api/booking/ops/health
// ---------------------------------------------------------------------------

export interface OpsHealthSchema {
  ok: boolean;
  // Bundled migrations whose filenames are absent from the D1 migrations ledger.
  missingMigrations: string[];
  // Whether live schema matches Reserva's migrations; false with none missing means a filename
  // collision with the consumer's own migrations.
  fingerprintOk: boolean;
  // The remediating message when `ok` is false; `null` when healthy.
  detail: string | null;
}

export interface OpsHealthOutboxFamily {
  family: SideEffectFamily;
  pending: number;
  abandoned: number;
}

export interface OpsHealthOutbox {
  // Every side effect that has neither succeeded nor been abandoned (pending, in flight, failed).
  pending: number;
  abandoned: number;
  oldestPendingAgeSeconds: number | null;
  // One entry per family that currently carries debt; empty when the outbox is fully drained.
  families: OpsHealthOutboxFamily[];
}

export interface OpsHealthResponse {
  schema: OpsHealthSchema;
  outbox: OpsHealthOutbox;
  incidents: { open: number };
}
