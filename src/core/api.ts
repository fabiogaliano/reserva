// The HTTP contract in one place: every handler response type and error envelope, exported from
// `@reservajs/astro/core` so a consumer's client types match the handlers exactly.
import type { WireBooking } from './booking.js';
import type { MetadataField, PickupType } from './config.js';
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
  // The cron sweep or another manual trigger already holds the reconciliation lease; retry later.
  'reconciliation_in_progress',
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

// Machine-readable companion to the human message: which input was rejected and, when the input is
// a closed set, what it may be — so a consumer can highlight the field without parsing prose.
export interface ApiErrorDetails {
  field?: string;
  allowed?: string[];
}

// The one failure shape every endpoint returns, at every status code.
export interface ApiErrorEnvelope {
  error: { code: ApiErrorCode; message: string; details?: ApiErrorDetails };
}

// ---------------------------------------------------------------------------
// GET /api/booking/availability
// ---------------------------------------------------------------------------

// `remaining` counts further bookings of the requested quantity that fit; `null` above
// `limitedThreshold` (exact capacity stays private). Full slots are omitted, so never 0.
export interface AvailabilitySlot {
  start: string;
  // The same instant as `start`, split into the business-local calendar day (`YYYY-MM-DD`) and
  // clock time (`HH:MM`) — so a consumer renders what the operator sees without re-deriving the
  // timezone projection from the offset, and gets it right across a DST boundary.
  date: string;
  time: string;
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
// module — the same rule checkout applies. A `locale` key is still tolerated on the wire (a
// payload builder shared with checkout sends one) but is not part of the contract: price never
// varies by locale.
export interface QuoteRequest {
  serviceSlug: string;
  quantity: number;
  pickup?: string;
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
  pickup?: string;
  meetingPointId?: string;
  // Consumer-declared fields, validated against the service's own declarations.
  metadata?: Record<string, unknown>;
}

export interface CheckoutResponse {
  checkoutUrl: string;
  bookingId: string;
  reference: string;
  // When the provider's payment page stops accepting payment (UTC ISO). The hold may outlive it
  // by a few minutes; falls back to the hold's own expiry for a provider that publishes no deadline.
  paymentDeadline: string;
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

// What the status endpoint keeps answering once the 4-hour detail grace has passed: enough for a
// returning visitor to recognize their booking, with nothing worth harvesting from a leaked link.
export interface ConfirmationSummary extends Pick<WireBooking, 'reference' | 'serviceTitle' | 'locale'> {
  start: string;
  end: string;
}

// Picked from `WireBooking` so a projection change breaks this at compile time. Reachable by
// anyone holding the payment session id, so it excludes contact details, ids, and tokens.
export interface ConfirmationBooking extends ConfirmationSummary, Pick<WireBooking, 'serviceSlug' | 'quantity' | 'priceMinor' | 'currency'> {
  meetingPoint: WireMeetingPoint | null;
  metadataRows: WireMetadataRow[];
}

// 'failed' is terminal for the customer: the session completed but its payment was not acceptable
// (a delayed payment method, or a mismatched amount/currency), so no booking was made and polling
// again cannot change the answer.
export type StatusState = 'pending' | 'confirmed' | 'failed' | 'cancelled' | 'expired' | 'not_found';

export interface StatusResponse {
  status: StatusState;
  // The full booking inside the detail grace window, the bare summary after it, `null` for every
  // non-confirmed state. `metadataRows` is what distinguishes the two shapes.
  booking: ConfirmationBooking | ConfirmationSummary | null;
}

// Reached only with the booking's cancel/operator token, so it can carry the full customer record.
export interface ManageBooking extends Pick<
  WireBooking,
  'reference' | 'serviceSlug' | 'serviceTitle' | 'quantity' | 'priceMinor' | 'currency' | 'locale' | 'status'
  | 'pickupAddress' | 'metadata'
  | 'customerName' | 'customerEmail' | 'customerPhone'
> {
  // The pickup option's id. Named `pickup` like the checkout and quote request field; the webhook
  // envelope's booking keeps `pickupType`, which is frozen for this release line.
  pickup: PickupType | null;
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
  cancelDeadline: string;
  // When the reschedule cutoff falls (`booking.reschedule.cutoffHours`), as a UTC instant. The two
  // are independent policies and are only equal when the deployment configures them that way.
  rescheduleDeadline: string;
  // @deprecated Alias of `cancelDeadline`, kept for one minor. Read `cancelDeadline`.
  deadline: string;
}

// The customer sends `token`; an operator sends either its own `operatorToken` or a `bookingId`
// with the operator bearer secret. `refund` is honoured on the operator path only.
export interface CancelRequest {
  token?: string;
  operatorToken?: string;
  bookingId?: string;
  refund?: 'none' | 'full' | 'partial';
  // Minor units of the booking's own currency, required for `refund: 'partial'` and rejected for
  // every other choice. Must be at least 1 and below the booking's price — 0 is `'none'` and the
  // whole price is `'full'`, so the recorded decision never overstates what moved.
  refundAmountMinor?: number;
}

// `start` is an ISO 8601 instant with an explicit offset, matching a generated slot start — the
// same spelling and format checkout takes.
export interface RescheduleRequest {
  start: string;
  token?: string;
  operatorToken?: string;
  bookingId?: string;
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
  // The service's own opaque `meta` passthrough, `{}` when the config declares none.
  meta: Record<string, unknown>;
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

// The published projection of a configured pricing rule. `pickup` is null for a location-less
// service, whose rows carry no pickup axis — always present, like every other catalog field.
export interface CatalogPricingRule {
  maxQuantity: number;
  pickup: string | null;
  priceMinor: number;
}

// Formula pricing as the catalog publishes it: `baseMinor` per unit of `seatsPerUnit` seats, times
// the units the party needs, plus the pickup option's surcharge (once per unit or once per
// booking). Every inherited field is already materialized, so `priceFor` needs nothing else.
export interface CatalogPricingFormula {
  baseMinor: number;
  surcharges: Record<string, number>;
  maxUnits: number;
  surchargeScope: 'unit' | 'booking';
  seatsPerUnit: number;
}

// Breakpoint rows or a formula, whichever the service was configured with. `Array.isArray` tells
// them apart; the `@reservajs/astro/core` helpers accept either.
export type CatalogPricing = CatalogPricingRule[] | CatalogPricingFormula;

// Everything a consumer needs before a date is chosen. Excludes schedule, turnaround, capacity,
// and occupancy — those live in the quote and availability endpoints.
export interface CatalogService {
  slug: string;
  title: string;
  durationMin: number;
  location: CatalogLocation | null;
  metadataFields: CatalogMetadataField[];
  // The pricing as configured, so a consumer can render a price table without a second request.
  pricing: CatalogPricing;
  // The largest party the service prices; what a party-size control counts up to.
  maxQuantity: number;
  // The "from €X" figure: the lowest amount any party size and pickup is charged.
  fromPriceMinor: number;
  // Whatever `ServiceConfig.meta` declared, echoed verbatim and never read by reserva, so a site
  // can serve its own content from the same call. `{}` when the config declares none.
  meta: Record<string, unknown>;
}

export interface CatalogResponse {
  services: CatalogService[];
  locales: { supported: string[]; default: string };
  currency: string;
  maxHorizonDays: number;
  // The admin-editable policy a site prints next to a price, so a rebuild picks up an edit.
  policy: { cancelCutoffHours: number; reschedule: { enabled: boolean; cutoffHours: number } };
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

// Reports the posture a deployment actually runs with; it never changes a default. `off` means the
// corresponding secret is unset, so that layer is not protecting anything.
export interface OpsHealthSecurity {
  csrfTokenLayer: 'on' | 'off';
  tokenEncryption: 'on' | 'off';
  adminAuth: 'access' | 'custom' | 'dev-bypass';
}

// What one bounded reconciliation pass did. Lives here rather than in `reconciliation.ts` because
// it is a wire shape now: the ops reconcile route returns it and ops health echoes the last one.
export interface ReconciliationSummary {
  expiredHoldsSwept: number;
  sideEffectBookingsProcessed: number;
  refundBookingsProcessed: number;
  incidentsOpened: number;
  incidentsUpdated: number;
  incidentsResolved: number;
  alertsSent: number;
  alertsFailed: number;
  // How many candidate pages this invocation drained. More than one means there was a backlog;
  // a run that stops at the wall clock reports the batches it did manage.
  batches: number;
}

// `lastRunAt` null means reconciliation has never completed on this deployment — the state a
// missing cron trigger leaves behind, which is why ops health reports it.
export interface OpsHealthReconciliation {
  lastRunAt: string | null;
  lastSummary: ReconciliationSummary | null;
}

export interface OpsHealthResponse {
  schema: OpsHealthSchema;
  outbox: OpsHealthOutbox;
  incidents: { open: number };
  security: OpsHealthSecurity;
  reconciliation: OpsHealthReconciliation;
}
