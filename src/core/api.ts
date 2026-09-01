// Plan 027 (design decision 2): the HTTP contract, in one place. Every handler response type and
// the error envelope live here and are exported from `@reservajs/astro/core`, so a consumer types
// its client against the same declarations the handlers return instead of re-declaring them (the
// first consumer's BookkitClient.ts re-declared all of them, which is what let them drift).
//
// Rules this file follows (direction doc §8):
// - one truth per fact: booking-bearing payloads are expressed in terms of `WireBooking`, the one
//   public booking projection (core/booking.ts), never as a parallel field list;
// - closed exported vocabularies: `API_ERROR_CODES` is a runtime array, and every other closed set
//   here derives from an existing one;
// - the empty-value rule: a collection is `[]`/`{}` and an absent optional module is `null`, so a
//   caller never branches on key presence.
import type { WireBooking } from './booking';
import type { MetadataField } from './config';
// Type-only (erased at build time): the ops-health payload reports outbox debt per operation
// family, and that family set is plan 021's `SIDE_EFFECT_FAMILIES` in src/repo.ts. Importing the
// derived type keeps the catalog single-sourced there rather than restating it here; nothing in
// this module depends on the repository at runtime.
import type { SideEffectFamily } from '../repo';

// Plan 027 (design decision 2): the closed set of `error.code` values every Reserva API failure
// can carry — one runtime array, with the union derived from it and `HttpError` (src/http.ts)
// typed against that union, so an unlisted code is a compile error rather than a surprise string
// a consumer's switch never handles. Growing it is deliberate: add one member here and the union,
// the throw sites, and plan 028's generated docs follow. Do not add an enum, a parallel union, a
// description map, or a schema for the same set.
export const API_ERROR_CODES = [
  // Request shape: the body/query failed validation, exceeded a body limit, or used a method the
  // route doesn't serve. `validation_failed` messages always name the offending field and the rule.
  'validation_failed',
  'method_not_allowed',
  'payload_too_large',
  // Authorization: a missing/expired/invalid booking token, operator secret, or admin identity.
  'forbidden',
  'not_found',
  // Booking rules: the action is understood but the booking's state or the clock forbids it.
  'past_cutoff',
  'invalid_transition',
  'slot_unavailable',
  'too_many_holds',
  // Payment verification: the provider's session disagrees with the booking it claims to pay for,
  // its webhook signature didn't verify, or its payment reference already confirmed another
  // booking.
  'payment_session_mismatch',
  'payment_amount_mismatch',
  'invalid_payment_signature',
  'duplicate_payment_ref',
  // Concurrency: another request holds this booking's confirmation lease; retry.
  'confirmation_in_progress',
  // Refunds: a competing refund decision, a booking with no payment reference to refund against,
  // or a provider that rejected the refund itself.
  'refund_conflict',
  'refund_payment_ref_missing',
  'refund_failed',
  // Dependencies: an upstream the request needed is temporarily unavailable.
  'calendar_unavailable',
  // The catch-all for an unclassified server fault (src/http.ts errorResponse).
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

// Plan 027 (design decision 4): scarcity is structured, never a rendered string. `remaining` is how
// many further bookings of the requested quantity still fit, and it is `null` whenever that number
// is above `limitedThreshold` — exact capacity is deployment-private, so only the scarce end of the
// range is published. Slots that fit nothing are omitted entirely (bookable-slots-only semantics),
// so `remaining` is never 0. Consumers that want Reserva's own copy read the message keys in
// SLOT_STATUS_MESSAGE_KEYS (src/ui/messages.ts).
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
  // The scarcity policy behind `AvailabilitySlot.remaining` and the `limited` day status, published
  // so a consumer can explain the threshold rather than guess it.
  limitedThreshold: number;
  days: AvailabilityDay[];
}

// ---------------------------------------------------------------------------
// POST /api/booking/quote
// ---------------------------------------------------------------------------

// Plan 027 (design decision 1): the pricing authority. `pickup` is required for a service that
// declares a location module and rejected for one that doesn't — the same rule (and the same code
// path) checkout applies to its own `pickupType` field.
export interface QuoteRequest {
  serviceSlug: string;
  quantity: number;
  pickup?: string | null;
  // Accepted (and locale-negotiated) so a consumer can quote with the same payload builder it uses
  // for checkout; a price never varies by locale.
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
  // Location module (plan 023): both rejected outright for a service that declares no location.
  pickupType?: string;
  meetingPointId?: string;
  // Consumer-declared fields (plan 024), validated against the service's own declarations.
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

// The presentation fields a rendered booking carries on top of the canonical projection: business-
// local start/end (the wire projection's `startsAt`/`endsAt` are UTC), the meeting point resolved
// against the booking's own stored id/label, and metadata rows already resolved to this booking's
// locale. `metadataRows` is deliberately NOT named `metadata`: the raw record on `WireBooking` is
// the value truth, these are display labels derived from it.
export interface WireMeetingPoint {
  label: string;
  mapsUrl: string | null;
}

export interface WireMetadataRow {
  key: string;
  label: string;
  value: string | number | boolean;
}

// Picked from WireBooking rather than restated, so a change to the one projection breaks these at
// compile time. The status payload is addressable by anyone holding the payment session id, so it
// stays a strict subset: no customer contact details, no ids, no tokens.
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

// The manage payload is reached only with a booking's own cancel/operator token, so it carries the
// full customer-facing record plus the presentation fields above.
export interface ManageBooking extends Pick<
  WireBooking,
  'reference' | 'serviceSlug' | 'quantity' | 'priceMinor' | 'currency' | 'locale' | 'status'
  | 'pickupType' | 'pickupAddress' | 'metadata'
  | 'customerName' | 'customerEmail' | 'customerPhone'
> {
  start: string;
  end: string;
  // Plan 023's always-present-nullable convention: `null` for a booking with no location data.
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

// Every manage/cancel/reschedule/no-show mutation answers with the same acknowledgement: the
// booking's new state is read back from GET /api/booking/manage (or pushed as a booking event), so
// the mutation response never becomes a second source for it.
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

// Plan 027 (design decision 6): the rendering contract — everything a consumer must know before a
// date is chosen. Deliberately absent: `turnaroundMin`, the raw schedule, pricing rules, capacity,
// and occupancy. Exact money is the quote endpoint's answer; bookable times and scarcity are
// availability's, behind `limitedThreshold`.
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
  // Whether the live schema matches what Reserva's migrations produce — false with no missing
  // migration means a filename collision with the consumer's own migrations (see plan 008).
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
