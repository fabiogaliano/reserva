// The published surface of `@reservajs/astro/core`, written out name by name. A wildcard here
// would promote every helper anyone adds under src/core/ to public API by accident; an explicit
// list makes widening the contract a deliberate edit.

// --- Wire contract -----------------------------------------------------------------------------
// Every request/response shape a client sends or parses, plus the closed error catalog. All of
// src/core/api.ts is contract, so this group mirrors it exactly.
export { API_ERROR_CODES, isApiErrorCode } from './api.js';
export type {
  ApiErrorCode,
  ApiErrorEnvelope,
  AvailabilitySlot,
  AvailabilityDayStatus,
  AvailabilityDay,
  AvailabilityResponse,
  QuoteRequest,
  QuoteResponse,
  CheckoutRequest,
  CheckoutResponse,
  WireMeetingPoint,
  WireMetadataRow,
  ConfirmationBooking,
  StatusState,
  StatusResponse,
  ManageBooking,
  ManageRole,
  ManageResponse,
  ManageActionResponse,
  ManageActionResponses,
  MetadataFieldType,
  CatalogMeetingPoint,
  CatalogPickupOption,
  CatalogLocation,
  CatalogMetadataFieldOption,
  CatalogMetadataField,
  CatalogService,
  CatalogResponse,
  OpsHealthSchema,
  OpsHealthOutboxFamily,
  OpsHealthOutbox,
  OpsHealthResponse,
} from './api.js';

// --- Booking events and provider ports ---------------------------------------------------------
// An adapter author must be able to implement a port from this subpath alone, so every type named
// in a port's signature ships with it. The event arrays are runtime values so a subscriber can
// enumerate the vocabulary instead of hardcoding it.
export { BOOKING_EVENTS, PAYMENT_EVENTS, BOOKING_EVENT_API_VERSION } from './events.js';
export type {
  BookingEvent,
  PaymentEvent,
  PaymentProvider,
  PaymentEventParsed,
  SessionStatus,
  EmailProvider,
  EmailBookingEvent,
  EmailRecipientRole,
  CalendarProvider,
  OperationalAlertSink,
  OperationalAlert,
  BookingEventEnvelope,
  BookingEventHook,
  BookingEventHookContext,
} from './events.js';
// `CalendarProvider.listEvents` resolves to these; they live in occupancy.ts only because that is
// where calendar busy-time is consumed. Nothing else from occupancy.ts is public.
export type { CalEvent, CalEventTime } from './occupancy.js';

// --- Configuration -----------------------------------------------------------------------------
// What a consumer writes in reserva.config.ts (`ClientConfig` and its sub-shapes) and what the
// runtime hands back to an adapter once defaults are applied (`Resolved*`).
export { validateConfig } from './config.js';
export type {
  ClientConfig,
  ResolvedClientConfig,
  ServiceConfig,
  ResolvedServiceConfig,
  ScheduleRule,
  PricingRule,
  MeetingPoint,
  PickupOption,
  PickupType,
  MetadataField,
  MetadataFieldOption,
  LocalizedText,
  WebhookEndpointConfig,
  MetadataRow,
} from './config.js';
// A payment adapter builds its checkout line items from the resolved config, which means looking
// up the service and its pickup option (@reservajs/stripe is the first consumer of both).
export { pickupOptionFor, resolveService } from './config.js';

// --- Booking domain ----------------------------------------------------------------------------
// The record a provider port receives and the canonical wire projection of it. The state
// transitions that produce these stay internal to the library's handlers.
export { toWireBooking } from './booking.js';
export type { Booking, WireBooking, BookingStatus, CancellationActor } from './booking.js';

// --- Money -------------------------------------------------------------------------------------
// Prices cross the wire in minor units, so any consumer rendering `priceMinor` needs the
// conversion; `priceFor` is what a payment adapter charges (@reservajs/stripe calls it directly).
export { toMajorUnits } from './currency.js';
export { priceFor } from './pricing.js';

// --- HTTP --------------------------------------------------------------------------------------
// The bounded body reader a payment adapter needs to parse a webhook safely (@reservajs/stripe is
// the first consumer). The rest of src/http.ts stays internal to the library's own handlers.
export { requestText, PAYMENT_WEBHOOK_BODY_LIMIT_BYTES } from '../http.js';
