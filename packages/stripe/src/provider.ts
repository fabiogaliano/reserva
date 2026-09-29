import {
  pickupOptionFor,
  priceFor,
  requestText,
  resolveService,
  resolveServiceTitle,
  PAYMENT_WEBHOOK_BODY_LIMIT_BYTES,
  type ApiErrorCode,
  type Booking,
  type DisputeOutcome,
  type ResolvedClientConfig,
  type PaymentEventParsed,
  type PaymentProvider,
  type SessionStatus,
} from '@reservajs/astro/core';
import type { ReservaResolvedRouteConfig } from '@reservajs/astro';
import {
  createStripeFetchClient,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  type StripeCheckoutCustomFieldParams,
  type StripeCheckoutSession,
  type StripeCheckoutSessionCreateParams,
  type StripeDispute,
  type StripeEvent,
  type StripeList,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeRefundCreateParams,
  type StripeRefundListParams,
} from './api.js';

// The slice of the Stripe API the provider calls, shaped like stripe-node's resources so an SDK
// instance (or a test double) can still be injected through `client`.
export interface StripeClient {
  checkout: { sessions: {
    create(params: StripeCheckoutSessionCreateParams, options?: { idempotencyKey?: string }): Promise<StripeCheckoutSession>;
    retrieve(sessionId: string): Promise<StripeCheckoutSession>;
  } };
  refunds: {
    create(params: StripeRefundCreateParams, options?: { idempotencyKey?: string }): Promise<StripeRefund>;
    // Optional: only needed for the already-fully-refunded reconciliation path in refund() below.
    list?(params: StripeRefundListParams): Promise<StripeList<StripeRefund>>;
  };
  // Optional: only the best-effort cancelPayment() path uses it, so an injected test double may omit it.
  paymentIntents?: {
    cancel(paymentIntentId: string): Promise<StripePaymentIntent>;
  };
  webhooks: { constructEventAsync(
    payload: string,
    signature: string,
    secret: string,
    tolerance?: number,
  ): Promise<StripeEvent> };
}

type BookingCallback<T> = (booking: Booking, config: ResolvedClientConfig) => T;
type UrlOption = string | BookingCallback<string>;

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  client?: StripeClient;
  now?: () => Date | number;
  successUrl?: UrlOption;
  cancelUrl?: UrlOption;
  // Overrides the line item's name on Stripe's hosted checkout; defaults to the service's
  // localized title.
  lineItemName?: UrlOption;
  // Shown under the name on Stripe's hosted checkout line item. Omitted when unset so the
  // checkout stays name-only.
  productDescription?: string | BookingCallback<string>;
  pickupFieldLabel?: string | BookingCallback<string>;
  // The optional headcount field a `collectGuestCount` service adds. Stripe caps a custom field
  // label at 50 characters.
  guestCountFieldLabel?: string | BookingCallback<string>;
  // Stripe rejects consent collection unless the account has a Terms of Service URL in its
  // public business details, which a not-yet-activated test account lacks. Defaults to
  // 'required' to keep the chargeback-defense consent record; set 'none' for such an account.
  termsOfService?: 'required' | 'none';
}

// Which methods a session offers is dashboard-managed (Stripe's dynamic payment methods), with one
// exception: Reserva cannot honour a method whose money arrives days later, because the capacity
// hold has expired long before. Stripe publishes no canonical "delayed" enumeration, so this list
// is curated from the per-method pages (2026-09): bank debits, bank transfer, and vouchers. Sent as
// `excluded_payment_method_types`, which Stripe rejects for apple_pay/google_pay/link — never add
// them here.
export const STRIPE_DELAYED_PAYMENT_METHOD_TYPES = [
  'us_bank_account', 'sepa_debit', 'bacs_debit', 'au_becs_debit', 'nz_bank_account', 'acss_debit',
  'customer_balance',
  'boleto', 'konbini', 'multibanco', 'oxxo',
] as const;

// Stripe Checkout's own supported `locale` values, and its 24-hour cap on how long a session may
// stay open. Both left core config because they are this vendor's limits, enforced in
// validateConfig() below.
export const STRIPE_SUPPORTED_LOCALES = new Set([
  'auto', 'bg', 'cs', 'da', 'de', 'el', 'en', 'en-GB', 'es', 'es-419', 'et',
  'fi', 'fil', 'fr', 'fr-CA', 'he', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt',
  'lv', 'ms', 'mt', 'nb', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sk', 'sl',
  'sv', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-HK', 'zh-TW',
]);

// The currencies Stripe can present at Checkout (docs.stripe.com/currencies, "Presentment
// currencies"). Reserva's core accepts any ISO 4217 code; this is the narrower set this
// adapter can actually charge in, which is why it lives here rather than in core.
export const STRIPE_SUPPORTED_CURRENCIES = new Set([
  'aed', 'afn', 'all', 'amd', 'ang', 'aoa', 'ars', 'aud', 'awg', 'azn', 'bam', 'bbd', 'bdt', 'bgn',
  'bif', 'bmd', 'bnd', 'bob', 'brl', 'bsd', 'bwp', 'byn', 'bzd', 'cad', 'cdf', 'chf', 'clp', 'cny',
  'cop', 'crc', 'cve', 'czk', 'djf', 'dkk', 'dop', 'dzd', 'egp', 'etb', 'eur', 'fjd', 'fkp', 'gbp',
  'gel', 'gip', 'gmd', 'gnf', 'gtq', 'gyd', 'hkd', 'hnl', 'hrk', 'htg', 'huf', 'idr', 'ils', 'inr',
  'isk', 'jmd', 'jpy', 'kes', 'kgs', 'khr', 'kmf', 'krw', 'kyd', 'kzt', 'lak', 'lbp', 'lkr', 'lrd',
  'lsl', 'mad', 'mdl', 'mga', 'mkd', 'mmk', 'mnt', 'mop', 'mur', 'mvr', 'mwk', 'mxn', 'myr', 'mzn',
  'nad', 'ngn', 'nio', 'nok', 'npr', 'nzd', 'pab', 'pen', 'pgk', 'php', 'pkr', 'pln', 'pyg', 'qar',
  'ron', 'rsd', 'rub', 'rwf', 'sar', 'sbd', 'scr', 'sek', 'sgd', 'shp', 'sle', 'sos', 'srd', 'std',
  'szl', 'thb', 'tjs', 'top', 'try', 'ttd', 'twd', 'tzs', 'uah', 'ugx', 'usd', 'uyu', 'uzs', 'vnd',
  'vuv', 'wst', 'xaf', 'xcd', 'xof', 'xpf', 'yer', 'zar', 'zmw',
]);

// 1440, not Stripe's exact 1445min cap, keeps expires_at 5 minutes under Stripe's 24h limit:
// expires_at is computed from Reserva's clock, not Stripe's, so a holdMinutes=1445 session would
// sit exactly on the edge and fail intermittently under clock skew.
export const STRIPE_MAX_HOLD_MINUTES = 1440;

// Stripe names European Portuguese `pt`, while the rest of Reserva uses the precise BCP 47 tag.
export function stripeLocaleFor(locale: string): string {
  return locale.toLowerCase() === 'pt-pt' ? 'pt' : locale;
}

export class StripeWebhookVerificationError extends Error {
  readonly status = 400;
  readonly code: ApiErrorCode = 'invalid_payment_signature';

  constructor() {
    super('Stripe webhook signature verification failed');
    this.name = 'StripeWebhookVerificationError';
  }
}

const defaultPickupFieldLabel = 'Pickup address';
const defaultGuestCountFieldLabel = 'Exact number of guests';
// Three digits is what the numeric field allows, so anything outside 1..999 is not a headcount the
// payer could have typed; it is dropped rather than stored as a misleading number.
const MAX_GUEST_COUNT = 999;
const checkoutSessionPlaceholder = '{CHECKOUT_SESSION_ID}';

function objectId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function metadataOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  return Object.fromEntries(Object.entries(metadata).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ));
}

function bookingIdOf(value: unknown): string | undefined {
  return metadataOf(value)?.bookingId;
}

function amountOf(value: unknown, field: 'amount_captured' | 'amount_refunded' | 'amount_total'): number | undefined {
  const amount = value && typeof value === 'object' ? (value as Record<string, unknown>)[field] : undefined;
  return typeof amount === 'number' ? amount : undefined;
}

function currencyOf(value: unknown): string | undefined {
  const currency = value && typeof value === 'object' ? (value as Record<string, unknown>).currency : undefined;
  return typeof currency === 'string' ? currency : undefined;
}

function paymentIntentOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const paymentIntent = (value as { payment_intent?: unknown }).payment_intent;
  if (typeof paymentIntent === 'string') return paymentIntent;
  if (paymentIntent && typeof paymentIntent === 'object' && 'id' in paymentIntent && typeof paymentIntent.id === 'string') {
    return paymentIntent.id;
  }
  return undefined;
}

function guestCountOf(value: string | null | undefined): number | null {
  const trimmed = value?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return count >= 1 && count <= MAX_GUEST_COUNT ? count : null;
}

function customerDetailsOf(session: StripeCheckoutSession): {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  pickupAddress?: string | null;
  guestCount?: number | null;
} {
  const details: {
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
    guestCount?: number | null;
  } = {};
  if (session.customer_details) {
    details.customerName = session.customer_details.name;
    details.customerEmail = session.customer_details.email;
    details.customerPhone = session.customer_details.phone;
  }
  const pickupField = session.custom_fields?.find((field) => field.key === 'pickup_address');
  if (pickupField) details.pickupAddress = pickupField.text?.value?.trim() || null;
  const guestCountField = session.custom_fields?.find((field) => field.key === 'guest_count');
  if (guestCountField) details.guestCount = guestCountOf(guestCountField.numeric?.value);
  return details;
}

function resolveOption<T>(option: T | BookingCallback<T> | undefined, booking: Booking, config: ResolvedClientConfig, fallback: T): T {
  return typeof option === 'function' ? (option as BookingCallback<T>)(booking, config) : option ?? fallback;
}

function nowMs(now: () => Date | number): number {
  const value = now();
  return value instanceof Date ? value.getTime() : value;
}

// Definitive errors were rejected on their merits, so retrying the same idempotency key would
// just replay the rejection — a 409 conflict counts too, since this provider always resends
// identical params, meaning another request already used that key. Everything else is ambiguous
// and worth one retry.
// Matched on the error's `type` (its class name) rather than instanceof, so errors thrown by an
// injected stripe-node client classify the same as this package's own.
const DEFINITIVE_STRIPE_ERROR_TYPES = new Set([
  'StripeCardError', 'StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError', 'StripeIdempotencyError',
]);

function stripeErrorType(error: unknown): string | undefined {
  const type = error && typeof error === 'object' ? (error as { type?: unknown }).type : undefined;
  return typeof type === 'string' ? type : undefined;
}

function isDefinitiveStripeError(error: unknown): boolean {
  const type = stripeErrorType(error);
  return type !== undefined && DEFINITIVE_STRIPE_ERROR_TYPES.has(type);
}

// `charge_already_refunded` happens when the idempotency key that would have replayed the
// original success has aged out (~24h) and the retry lands as a fresh request against an
// already-refunded charge — the money moved on the earlier attempt, so this is worth
// reconciling (exact amount + this request's marker) before rethrowing as definitive.
function isChargeAlreadyRefundedError(error: unknown): boolean {
  return stripeErrorType(error) === 'StripeInvalidRequestError'
    && (error as { code?: unknown }).code === 'charge_already_refunded';
}

// Carries the booking's locale: the confirmation page's pending, failed and expired states have no
// booking in the status payload to read it from, and would otherwise fall back to the default.
function defaultSuccessUrl(booking: Booking, config: ResolvedClientConfig, routePaths?: ReservaResolvedRouteConfig['paths']): string {
  return `${config.business.url.replace(/\/$/, '')}${routePaths?.confirmationPage ?? '/booking-confirmation'}?sessionId=${checkoutSessionPlaceholder}&locale=${encodeURIComponent(booking.locale)}`;
}

// The site root, not a per-service page: the library does not own the consumer's URL scheme, so
// guessing `/services/<slug>` sent abandoned payers to a 404 on sites shaped differently.
function defaultCancelUrl(config: ResolvedClientConfig): string {
  return config.business.url.replace(/\/$/, '');
}


export function sessionStatusFromStripe(session: StripeCheckoutSession): SessionStatus {
  const metadata = metadataOf(session);
  const amountTotal = amountOf(session, 'amount_total');
  const currency = currencyOf(session);
  return {
    id: session.id,
    status: session.status ?? 'unknown',
    paymentStatus: session.payment_status,
    ...(amountTotal !== undefined ? { amountTotal } : {}),
    ...(currency !== undefined ? { currency } : {}),
    paymentRef: objectId(session.payment_intent),
    ...customerDetailsOf(session),
    ...(metadata ? { metadata } : {}),
  };
}


// An event Reserva has no name for keeps Stripe's own string and is ignored downstream.
const PAYMENT_EVENT_BY_STRIPE_TYPE: Record<string, PaymentEventParsed['type']> = {
  'checkout.session.completed': 'checkout_completed',
  'checkout.session.expired': 'checkout_expired',
  'checkout.session.async_payment_succeeded': 'async_payment_succeeded',
  // A delayed payment that never arrived needs nothing beyond what an expired checkout already
  // does: release the hold, idempotently.
  'checkout.session.async_payment_failed': 'checkout_expired',
  'charge.refunded': 'refunded',
  'charge.dispute.created': 'dispute_created',
  'charge.dispute.closed': 'dispute_closed',
};

// A closed dispute's status, reduced to whether the money stayed with the business. Any status not
// listed here (Stripe's type leaves the set open) yields no outcome, so Reserva keeps the dispute
// open for the operator to check in the dashboard rather than guessing.
const DISPUTE_OUTCOME_BY_STRIPE_STATUS: Record<string, DisputeOutcome> = {
  won: 'won',
  // A bank inquiry that closed without becoming a chargeback: no money was ever withdrawn.
  warning_closed: 'won',
  lost: 'lost',
  // Settled through a prevention programme (Visa RDR, Ethoca alerts) by refunding the cardholder,
  // so the money went back even though no chargeback was filed.
  prevented: 'lost',
};

export function stripeEventToParsed(event: StripeEvent): PaymentEventParsed {
  const object = event.data.object as unknown;
  const parsed: PaymentEventParsed = {
    id: event.id,
    type: PAYMENT_EVENT_BY_STRIPE_TYPE[event.type] ?? event.type,
    raw: event,
  };
  if (
    event.type === 'checkout.session.completed'
    || event.type === 'checkout.session.expired'
    || event.type === 'checkout.session.async_payment_succeeded'
    || event.type === 'checkout.session.async_payment_failed'
  ) {
    const session = object as StripeCheckoutSession;
    const bookingId = bookingIdOf(session);
    const paymentIntent = objectId(session.payment_intent);
    const amountCaptured = amountOf(session, 'amount_total');
    Object.assign(parsed, customerDetailsOf(session));
    if (bookingId) parsed.bookingId = bookingId;
    if (session.id) parsed.sessionRef = session.id;
    if (paymentIntent) parsed.paymentRef = paymentIntent;
    if (amountCaptured !== undefined) parsed.amountCaptured = amountCaptured;
    const currency = currencyOf(session);
    if (currency !== undefined) parsed.currency = currency;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      parsed.paid = session.payment_status === 'paid';
      parsed.paymentStatus = session.payment_status;
    }
    return parsed;
  }
  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
    const charge = object as { metadata?: Record<string, string> | null; paid?: boolean };
    const bookingId = bookingIdOf(charge);
    const paymentIntent = paymentIntentOf(charge);
    const amountCaptured = amountOf(charge, 'amount_captured');
    const amountRefunded = amountOf(charge, 'amount_refunded');
    if (bookingId) parsed.bookingId = bookingId;
    if (paymentIntent) parsed.paymentRef = paymentIntent;
    if (amountCaptured !== undefined) parsed.amountCaptured = amountCaptured;
    if (amountRefunded !== undefined) parsed.amountRefunded = amountRefunded;
    // No `refundRef`: Stripe stopped expanding `charge.refunds` in the charge payload (API
    // 2022-11-15), and the refund id is only needed by `refund.created` subscribers. The
    // cancel-on-full-refund path keys off the amounts, not the id.
    if (charge.paid !== undefined) parsed.paid = charge.paid;
    if (event.type !== 'charge.refunded') {
      const created = (object as StripeDispute).created;
      if (typeof created === 'number') parsed.disputeCreatedAt = new Date(created * 1000).toISOString();
    }
    if (event.type === 'charge.dispute.closed') {
      const outcome = DISPUTE_OUTCOME_BY_STRIPE_STATUS[(object as StripeDispute).status];
      if (outcome) parsed.disputeOutcome = outcome;
    }
  }
  return parsed;
}


// Constructed only through the `stripe(options)` factory; the class itself is never part of
// the published surface.
export class StripeProvider implements PaymentProvider {
  readonly stripe: StripeClient;
  readonly webhookSecret: string;
  private readonly now: () => Date | number;
  private readonly options: StripeOptions;

  constructor(options: StripeOptions) {
    if (!options.secretKey) throw new Error('Stripe secret key is required');
    if (!options.webhookSecret) throw new Error('Stripe webhook secret is required');
    this.stripe = options.client ?? createStripeFetchClient(options.secretKey);
    this.webhookSecret = options.webhookSecret;
    this.now = options.now ?? (() => Date.now());
    this.options = options;
  }

  async createCheckout(
    booking: Booking,
    config: ResolvedClientConfig,
    routePaths?: ReservaResolvedRouteConfig['paths'],
  ): Promise<{ url: string; sessionRef: string; expiresAt: string }> {
    const service = resolveService(config, booking.serviceSlug);
    // The line item is the one thing the payer reads on Stripe's page, so it defaults to the
    // service's own localized title — the slug is an identifier, never a name.
    const name = resolveOption(this.options.lineItemName, booking, config, resolveServiceTitle(config, booking.serviceSlug, booking.locale));
    const description = resolveOption(this.options.productDescription, booking, config, '').trim();
    const successUrl = resolveOption(this.options.successUrl, booking, config, defaultSuccessUrl(booking, config, routePaths));
    const cancelUrl = resolveOption(this.options.cancelUrl, booking, config, defaultCancelUrl(config));
    const pickupLabel = resolveOption(this.options.pickupFieldLabel, booking, config, defaultPickupFieldLabel);
    const guestCountLabel = resolveOption(this.options.guestCountFieldLabel, booking, config, defaultGuestCountFieldLabel);
    const expiresInMinutes = Math.max(30, config.booking.holdMinutes - 5);
    const params: StripeCheckoutSessionCreateParams = {
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: {
        currency: config.business.currency,
        unit_amount: priceFor(service, booking.quantity, booking.pickupType),
        product_data: { name, ...(description ? { description } : {}) },
      } }],
      expires_at: Math.floor(nowMs(this.now) / 1000) + expiresInMinutes * 60,
      locale: stripeLocaleFor(booking.locale),
      // No `payment_method_types`: sending it overrides the dashboard and hides Apple Pay, Google
      // Pay and Link. The exclusion list is the cheap guard against a dashboard that enables a
      // delayed method by mistake; the webhook's refusal path is the real backstop.
      excluded_payment_method_types: [...STRIPE_DELAYED_PAYMENT_METHOD_TYPES],
      submit_type: 'book',
      phone_number_collection: { enabled: true },
      metadata: { bookingId: booking.id },
      payment_intent_data: { metadata: { bookingId: booking.id } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    };
    // Keyed off the service's declared option instead of a fixed 'custom' id, so any option
    // marked requiresAddress collects the field. A stored pickupType the service no longer
    // declares resolves to undefined, safely skipping the field rather than guessing.
    const customFields: StripeCheckoutCustomFieldParams[] = [];
    if (pickupOptionFor(service, booking.pickupType)?.requiresAddress) customFields.push({
      key: 'pickup_address', label: { type: 'custom', custom: pickupLabel }, type: 'text',
    });
    // Optional so a payer who does not know yet is never blocked from paying for the slot.
    if (service.collectGuestCount) customFields.push({
      key: 'guest_count', label: { type: 'custom', custom: guestCountLabel }, type: 'numeric',
      optional: true, numeric: { maximum_length: 3 },
    });
    if (customFields.length > 0) params.custom_fields = customFields;
    // With no `legal.termsUrl` there is nothing for the payer to consent to, so absence degrades
    // to the same 'none' an unactivated Stripe account needs rather than a consent step pointing nowhere.
    if ((this.options.termsOfService ?? 'required') === 'required' && config.legal.termsUrl) {
      params.consent_collection = { terms_of_service: 'required' };
    }
    // A deterministic key per hold (not per call) so a lost response and a retried call both
    // land on the same Stripe session instead of minting a second, orphaned one.
    const idempotencyKey = `reserva-checkout-${booking.id}`;
    const session = await this.createSession(params, idempotencyKey);
    if (!session.url) throw new Error('Stripe Checkout Session did not include a URL');
    // Stripe's own expiry, not the one requested above: a replayed idempotent create returns the
    // original session, whose expires_at is older than this call's computed value.
    return {
      url: session.url,
      sessionRef: session.id,
      expiresAt: new Date((session.expires_at || params.expires_at || 0) * 1000).toISOString(),
    };
  }

  // Best effort by contract. Stripe only lets a Checkout payment intent be cancelled in some
  // states (a voucher awaiting payment can be; a `processing` bank debit cannot), so every
  // failure — including a client injected without `paymentIntents` — is a logged no-op.
  async cancelPayment(paymentRef: string): Promise<void> {
    try {
      const paymentIntents = this.stripe.paymentIntents;
      if (!paymentIntents) throw new Error('Stripe client does not expose paymentIntents.cancel');
      await paymentIntents.cancel(paymentRef);
    } catch (error) {
      // console, not a Reserva logger: the adapter is constructed outside the request context and
      // has no logger port of its own.
      console.warn('stripe cancelPayment failed', {
        paymentRef,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Stripe only replays the cached response for a reused idempotency key when the retry carries
  // byte-identical params (otherwise it 409s) — reusing the same `params` object reference
  // guarantees that. A retry is skipped for errors that were actually rejected, not ambiguous.
  private async createSession(
    params: StripeCheckoutSessionCreateParams,
    idempotencyKey: string,
  ): Promise<StripeCheckoutSession> {
    try {
      return await this.stripe.checkout.sessions.create(params, { idempotencyKey });
    } catch (error) {
      if (isDefinitiveStripeError(error)) throw error;
      return await this.stripe.checkout.sessions.create(params, { idempotencyKey });
    }
  }

  async parseWebhook(request: Request): Promise<PaymentEventParsed> {
    const signature = request.headers.get('stripe-signature');
    if (!signature) throw new StripeWebhookVerificationError();
    // Read outside the try: an oversized body must surface as HttpError(413), not collapse into
    // a generic verification error. The text is passed to constructEventAsync unchanged, since
    // Stripe's signature was computed over these exact bytes — re-serializing would break it.
    const payload = await requestText(request, PAYMENT_WEBHOOK_BODY_LIMIT_BYTES);
    try {
      const event = await this.stripe.webhooks.constructEventAsync(
        payload, signature, this.webhookSecret, STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      );
      return stripeEventToParsed(event);
    } catch {
      throw new StripeWebhookVerificationError();
    }
  }

  async getSession(sessionRef: string): Promise<SessionStatus> {
    return sessionStatusFromStripe(await this.stripe.checkout.sessions.retrieve(sessionRef));
  }

  // Stripe's own limits, checked once at runtime init instead of leaking into ClientConfig's
  // schema. Every message names the config path and the fix, so a misconfigured deployment
  // fails to start with something actionable rather than 500ing on the first checkout.
  validateConfig(config: ResolvedClientConfig): void {
    if (config.booking.holdMinutes > STRIPE_MAX_HOLD_MINUTES) {
      throw new Error(
        `booking.holdMinutes is ${config.booking.holdMinutes}; Stripe Checkout sessions cannot stay open longer `
        + `than 24 hours, so set it to at most ${STRIPE_MAX_HOLD_MINUTES}.`,
      );
    }
    for (const locale of config.locales.supported) {
      if (!STRIPE_SUPPORTED_LOCALES.has(stripeLocaleFor(locale))) {
        throw new Error(
          `locales.supported contains "${locale}", which Stripe Checkout has no locale for. `
          + `Remove it, or use one of: ${[...STRIPE_SUPPORTED_LOCALES].join(', ')}.`,
        );
      }
    }
    if (!STRIPE_SUPPORTED_CURRENCIES.has(config.business.currency.toLowerCase())) {
      throw new Error(
        `business.currency "${config.business.currency}" is not a currency Stripe presents at checkout. `
        + 'Use an ISO 4217 code from Stripe\'s supported list (https://docs.stripe.com/currencies).',
      );
    }
  }

  async refund(paymentRef: string, expectedAmountMinor: number): Promise<{ refundRef: string; amountMinor: number }> {
    // This marker is persisted on the Stripe Refund object and is the only evidence
    // findExistingRefund can match after a crash mid-create — its shape is an external contract.
    // A refund under a changed marker shape surfaces as an operator incident, not a silent
    // double refund.
    // Deliberately not amount-qualified, even though partial refunds exist: Reserva keeps exactly
    // one refund operation per booking, so one payment reference has exactly one decided amount.
    // Folding the amount in would let a retry carrying a different one mint a second real refund
    // instead of replaying the first.
    const idempotencyKey = `reserva-refund-${paymentRef}`;
    let created: StripeRefund;
    try {
      // `amount` is always explicit, never left to Stripe's refund-the-rest default: a partial
      // refund needs it, and stating it for a full one makes the call say exactly what the
      // operation decided instead of whatever happens to remain refundable on the charge.
      created = await this.stripe.refunds.create(
        { payment_intent: paymentRef, amount: expectedAmountMinor, metadata: { reserva_refund_key: idempotencyKey } },
        { idempotencyKey },
      );
    } catch (error) {
      if (isDefinitiveStripeError(error) && !isChargeAlreadyRefundedError(error)) throw error;
      // A list result is proof of success only when the refund carries this request's marker and
      // its own amount is exact.
      const reconciled = await this.findExistingRefund(paymentRef, expectedAmountMinor, idempotencyKey);
      if (reconciled) return reconciled;
      throw error;
    }
    if (created.status !== 'succeeded') {
      throw new Error(`Stripe refund ${created.id} did not succeed (status ${created.status ?? 'unknown'})`);
    }
    if (created.amount !== expectedAmountMinor) {
      throw new Error(`Stripe refund amount ${created.amount} did not match expected total ${expectedAmountMinor}`);
    }
    return { refundRef: created.id, amountMinor: expectedAmountMinor };
  }

  private async findExistingRefund(
    paymentRef: string,
    expectedAmountMinor: number,
    idempotencyKey: string,
  ): Promise<{ refundRef: string; amountMinor: number } | null> {
    try {
      const list = await this.stripe.refunds.list?.({ payment_intent: paymentRef, limit: 100 });
      if (!list) return null;
      const matched = list.data.find((candidate) => (
        candidate.status === 'succeeded'
        && candidate.amount === expectedAmountMinor
        && candidate.metadata?.reserva_refund_key === idempotencyKey
      ));
      return matched ? { refundRef: matched.id, amountMinor: expectedAmountMinor } : null;
    } catch {
      // Listing is only reconciliation evidence; retain the original create failure if unavailable.
      return null;
    }
  }
}
