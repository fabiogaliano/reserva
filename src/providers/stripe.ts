import Stripe from 'stripe';
import type { ApiErrorCode } from '../core/api';
import type { Booking } from '../core/booking';
import type { ClientConfig } from '../core/config';
import { pickupOptionFor, resolveService } from '../core/config';
import type { PaymentProvider, SessionStatus, PaymentEventParsed } from '../core/events';
import { priceFor } from '../core/pricing';
import { requestText, STRIPE_WEBHOOK_BODY_LIMIT_BYTES } from '../http';
import type { BookkitResolvedRouteConfig } from '../routes-manifest';

export interface StripeClient {
  checkout: { sessions: {
    create(params: Stripe.Checkout.SessionCreateParams, options?: { idempotencyKey?: string }): Promise<Stripe.Checkout.Session>;
    retrieve(sessionId: string): Promise<Stripe.Checkout.Session>;
  } };
  refunds: {
    create(params: Stripe.RefundCreateParams, options?: { idempotencyKey?: string }): Promise<Stripe.Refund>;
    // Optional: only needed for the already-fully-refunded reconciliation path in refund() below.
    list?(params: Stripe.RefundListParams): Promise<Stripe.ApiList<Stripe.Refund>>;
  };
  webhooks: { constructEventAsync(
    payload: string,
    signature: string,
    secret: string,
    tolerance?: number,
    cryptoProvider?: Stripe.CryptoProvider,
  ): Promise<Stripe.Event> };
}

type BookingCallback<T> = (booking: Booking, config: ClientConfig) => T;
type UrlOption = string | BookingCallback<string>;

export interface StripeProviderOptions {
  secretKey?: string;
  apiKey?: string;
  webhookSecret: string;
  client?: StripeClient;
  stripe?: StripeClient;
  stripeClient?: StripeClient;
  now?: () => Date | number;
  successUrl?: UrlOption;
  cancelUrl?: UrlOption;
  getSuccessUrl?: BookingCallback<string>;
  getCancelUrl?: BookingCallback<string>;
  getServiceName?: BookingCallback<string>;
  serviceName?: BookingCallback<string>;
  getProductName?: BookingCallback<string>;
  productName?: BookingCallback<string>;
  getLineItemName?: BookingCallback<string>;
  // Shown under the name on Stripe's hosted checkout line item. Omitted when
  // unset so the checkout stays name-only, matching prior behaviour.
  productDescription?: string | BookingCallback<string>;
  pickupFieldLabel?: string | BookingCallback<string>;
  // Plan 022 (design decision 7): payment methods are adapter configuration, not a Reserva setting
  // — the accepted set is Stripe's, changing it needs a Stripe dashboard capability, and no other
  // provider shares the vocabulary. Defaults to card-only.
  paymentMethods?: StripePaymentMethod[];
  // Stripe rejects consent collection unless the account has a Terms of Service
  // URL in its public business details, which a not-yet-activated test account
  // lacks. Defaults to 'required' so operators keep the chargeback-defense
  // consent record; set 'none' to run against such an account.
  termsOfService?: 'required' | 'none';
}

type PositionalOptions = Omit<StripeProviderOptions, 'secretKey' | 'webhookSecret'>;

// The Stripe payment method types this adapter is tested against.
export type StripePaymentMethod = 'card' | 'mb_way';

const DEFAULT_PAYMENT_METHODS: readonly StripePaymentMethod[] = ['card'];

// Stripe Checkout's own supported `locale` values, and its 24-hour cap on how long a session may
// stay open. Both left core config with plan 022 (design decision 7): they are this vendor's
// limits, enforced in validateConfig() below.
export const STRIPE_SUPPORTED_LOCALES = new Set([
  'auto', 'bg', 'cs', 'da', 'de', 'el', 'en', 'en-GB', 'es', 'es-419', 'et',
  'fi', 'fil', 'fr', 'fr-CA', 'he', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt',
  'lv', 'ms', 'mt', 'nb', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sk', 'sl',
  'sv', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-HK', 'zh-TW',
]);

// The currencies Stripe can present at Checkout (docs.stripe.com/currencies, "Presentment
// currencies", 2026-09). Reserva's own core accepts any ISO 4217 code (core/currency.ts); this is
// the narrower set THIS adapter can actually charge in, which is exactly why it lives here.
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

// 1440 (not Stripe's exact 1445min cap) keeps expires_at 5 minutes under Stripe's 24h-from-creation
// limit, since expires_at is computed from Reserva's clock, not Stripe's — a holdMinutes=1445
// session would sit exactly on the edge and fail intermittently under clock skew (see
// expiresInMinutes in createCheckout below).
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

// The charge.refunded payload's `refunds` list has the actual Refund objects; its most recent
// entry is the refund this event is about. Absent in older API versions/partial payloads, hence
// optional chaining throughout — the operation record just falls back to no refund id then.
function refundIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const refunds = (value as { refunds?: { data?: Array<{ id?: string }> } }).refunds;
  const id = refunds?.data?.[0]?.id;
  return typeof id === 'string' ? id : undefined;
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

function customerDetailsOf(session: Stripe.Checkout.Session): {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  pickupAddress?: string | null;
} {
  const details: {
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
  } = {};
  if (session.customer_details) {
    details.customerName = session.customer_details.name;
    details.customerEmail = session.customer_details.email;
    details.customerPhone = session.customer_details.phone;
  }
  const pickupField = session.custom_fields?.find((field) => field.key === 'pickup_address');
  if (pickupField) details.pickupAddress = pickupField.text?.value?.trim() || null;
  return details;
}

function resolveOption<T>(option: T | BookingCallback<T> | undefined, booking: Booking, config: ClientConfig, fallback: T): T {
  return typeof option === 'function' ? (option as BookingCallback<T>)(booking, config) : option ?? fallback;
}

function nowMs(now: () => Date | number): number {
  const value = now();
  return value instanceof Date ? value.getTime() : value;
}

// Errors that mean the request was rejected on its merits (bad params/card/auth/permission) —
// Stripe's idempotency layer caches and replays error responses too (see refund()'s comment
// below), so retrying one of these with the same key would just reproduce the same rejection
// rather than ever succeeding. Everything else (network failures, 5xx, unrecognized errors) is
// treated as ambiguous — the request may have actually gone through — and is worth one retry.
// StripeIdempotencyError (409, same key + conflicting params) is also definitive: this provider
// always resends the identical params object on retry, so a same-key conflict can only mean a
// different request already used this key — retrying with the same params would 409 again.
// One definitive error still gets a reconciliation check in refund() before it's rethrown: a
// StripeInvalidRequestError with code charge_already_refunded, which Stripe returns as a 400 when
// the refund actually succeeded earlier (e.g. the response was lost, and the idempotency key
// later aged out of Stripe's ~24h cache) — see the dedicated check at the refund() call site.
function isDefinitiveStripeError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeCardError
    || error instanceof Stripe.errors.StripeInvalidRequestError
    || error instanceof Stripe.errors.StripeAuthenticationError
    || error instanceof Stripe.errors.StripePermissionError
    || error instanceof Stripe.errors.StripeIdempotencyError;
}

// Narrow definitive-error carve-out: `charge_already_refunded` is what Stripe returns when the
// idempotency key that would have replayed the original success has already been pruned (~24h)
// and the retry lands as a fresh request against an already-fully-refunded charge. The money
// moved on the earlier attempt; only reconciliation (exact amount + this request's marker) proves
// it, so this is the one case worth checking before rethrowing a "definitive" error.
function isChargeAlreadyRefundedError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'charge_already_refunded';
}

function defaultSuccessUrl(config: ClientConfig, routePaths?: BookkitResolvedRouteConfig['paths']): string {
  return `${config.business.url.replace(/\/$/, '')}${routePaths?.confirmationPage ?? '/booking-confirmation'}?session_id=${checkoutSessionPlaceholder}`;
}

function defaultCancelUrl(booking: Booking, config: ClientConfig): string {
  return `${config.business.url.replace(/\/$/, '')}/services/${booking.serviceSlug}`;
}

export function stripePaymentMethodTypes(methods: readonly StripePaymentMethod[]): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] {
  return [...methods] as Stripe.Checkout.SessionCreateParams.PaymentMethodType[];
}

export const mapPaymentMethods = stripePaymentMethodTypes;

export function sessionStatusFromStripe(session: Stripe.Checkout.Session): SessionStatus {
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

export const mapSessionStatus = sessionStatusFromStripe;

// Maps Stripe's own event names onto Reserva's PAYMENT_EVENTS vocabulary (core/events.ts). An event
// Reserva has no name for keeps Stripe's string and is ignored downstream.
const PAYMENT_EVENT_BY_STRIPE_TYPE: Record<string, PaymentEventParsed['type']> = {
  'checkout.session.completed': 'checkout_completed',
  'checkout.session.expired': 'checkout_expired',
  'charge.refunded': 'refunded',
  'charge.dispute.created': 'dispute_created',
};

export function stripeEventToParsed(event: Stripe.Event): PaymentEventParsed {
  const object = event.data.object as unknown;
  const parsed: PaymentEventParsed = {
    id: event.id,
    type: PAYMENT_EVENT_BY_STRIPE_TYPE[event.type] ?? event.type,
    raw: event,
  };
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
    const session = object as Stripe.Checkout.Session;
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
    if (event.type === 'checkout.session.completed') {
      parsed.paid = session.payment_status === 'paid';
      parsed.paymentStatus = session.payment_status;
    }
    return parsed;
  }
  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    const charge = object as { metadata?: Record<string, string> | null; paid?: boolean };
    const bookingId = bookingIdOf(charge);
    const paymentIntent = paymentIntentOf(charge);
    const amountCaptured = amountOf(charge, 'amount_captured');
    const amountRefunded = amountOf(charge, 'amount_refunded');
    const refundId = event.type === 'charge.refunded' ? refundIdOf(charge) : undefined;
    if (bookingId) parsed.bookingId = bookingId;
    if (paymentIntent) parsed.paymentRef = paymentIntent;
    if (amountCaptured !== undefined) parsed.amountCaptured = amountCaptured;
    if (amountRefunded !== undefined) parsed.amountRefunded = amountRefunded;
    if (refundId !== undefined) parsed.refundRef = refundId;
    if (charge.paid !== undefined) parsed.paid = charge.paid;
  }
  return parsed;
}

export const mapStripeEvent = stripeEventToParsed;
export const parseStripeEvent = stripeEventToParsed;

export class StripeProvider implements PaymentProvider {
  readonly stripe: StripeClient;
  readonly webhookSecret: string;
  private readonly now: () => Date | number;
  private readonly options: PositionalOptions;

  constructor(options: StripeProviderOptions);
  constructor(secretKey: string, webhookSecret: string, options?: PositionalOptions);
  constructor(secretOrOptions: string | StripeProviderOptions, positionalWebhookSecret?: string, positionalOptions: PositionalOptions = {}) {
    const options: StripeProviderOptions = typeof secretOrOptions === 'string'
      ? { ...positionalOptions, secretKey: secretOrOptions, webhookSecret: positionalWebhookSecret ?? '' }
      : secretOrOptions;
    const secretKey = options.secretKey ?? options.apiKey;
    if (!secretKey) throw new Error('Stripe secret key is required');
    if (!options.webhookSecret) throw new Error('Stripe webhook secret is required');
    this.stripe = options.client ?? options.stripe ?? options.stripeClient ?? new Stripe(secretKey) as unknown as StripeClient;
    this.webhookSecret = options.webhookSecret;
    this.now = options.now ?? (() => Date.now());
    this.options = options;
  }

  async createCheckout(
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<{ url: string; sessionRef: string }> {
    const service = resolveService(config, booking.serviceSlug);
    const nameCallback = this.options.getServiceName
      ?? this.options.serviceName
      ?? this.options.getProductName
      ?? this.options.productName
      ?? this.options.getLineItemName;
    const name = resolveOption(nameCallback, booking, config, booking.serviceSlug);
    const description = resolveOption(this.options.productDescription, booking, config, '').trim();
    const successUrl = this.options.getSuccessUrl?.(booking, config)
      ?? resolveOption(this.options.successUrl, booking, config, defaultSuccessUrl(config, routePaths));
    const cancelUrl = this.options.getCancelUrl?.(booking, config)
      ?? resolveOption(this.options.cancelUrl, booking, config, defaultCancelUrl(booking, config));
    const pickupLabel = resolveOption(this.options.pickupFieldLabel, booking, config, defaultPickupFieldLabel);
    const expiresInMinutes = Math.max(30, config.booking.holdMinutes - 5);
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: {
        currency: config.business.currency,
        unit_amount: priceFor(service, booking.quantity, booking.pickupType),
        product_data: { name, ...(description ? { description } : {}) },
      } }],
      expires_at: Math.floor(nowMs(this.now) / 1000) + expiresInMinutes * 60,
      locale: stripeLocaleFor(booking.locale) as Stripe.Checkout.SessionCreateParams.Locale,
      payment_method_types: stripePaymentMethodTypes(this.options.paymentMethods ?? DEFAULT_PAYMENT_METHODS),
      phone_number_collection: { enabled: true },
      metadata: { bookingId: booking.id },
      payment_intent_data: { metadata: { bookingId: booking.id } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    };
    // Plan 018 (design decision 7): re-keyed off the service's declared option instead of the fixed
    // 'custom' id, so any option a service marks requiresAddress collects the field, not just the id
    // literally named 'custom'. An undeclared stored pickupType (the service's pickupOptions changed
    // after this booking's hold was created) resolves option to undefined, and `undefined?.` is
    // falsy — the safe degrade is to skip the field rather than guess, since Stripe would otherwise
    // collect an address label for an option the operator no longer recognizes.
    if (pickupOptionFor(service, booking.pickupType)?.requiresAddress) params.custom_fields = [{
      key: 'pickup_address', label: { type: 'custom', custom: pickupLabel }, type: 'text',
    }];
    if ((this.options.termsOfService ?? 'required') === 'required') {
      params.consent_collection = { terms_of_service: 'required' };
    }
    // BK-PAY-002: a deterministic key per hold (not per call) so a lost response and a retried
    // call both land on the same Stripe session instead of minting a second, orphaned one.
    const idempotencyKey = `bookkit-checkout-${booking.id}`;
    const session = await this.createSession(params, idempotencyKey);
    if (!session.url) throw new Error('Stripe Checkout Session did not include a URL');
    return { url: session.url, sessionRef: session.id };
  }

  // Stripe only replays the cached response for a reused idempotency key when the retried request
  // carries byte-identical params (otherwise it 409s with idempotency_error) — passing the exact
  // same `params` object reference to both attempts (never rebuilt in between) guarantees that.
  // A retry is only useful when the first attempt was ambiguous (the response was lost, but the
  // session may already exist); isDefinitiveStripeError skips the pointless retry-then-rethrow
  // round trip for a request that was actually rejected.
  private async createSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ): Promise<Stripe.Checkout.Session> {
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
    // Read outside the try below: an oversized body must surface as HttpError(413), not get
    // collapsed into a generic StripeWebhookVerificationError — and the decoded text is passed to
    // constructEventAsync completely unchanged, since Stripe's signature was computed over these
    // exact bytes and any re-serialization would break verification.
    const payload = await requestText(request, STRIPE_WEBHOOK_BODY_LIMIT_BYTES);
    try {
      const event = await this.stripe.webhooks.constructEventAsync(
        payload, signature, this.webhookSecret, 300, Stripe.createSubtleCryptoProvider(),
      );
      return stripeEventToParsed(event);
    } catch {
      throw new StripeWebhookVerificationError();
    }
  }

  async getSession(sessionRef: string): Promise<SessionStatus> {
    return sessionStatusFromStripe(await this.stripe.checkout.sessions.retrieve(sessionRef));
  }

  // Plan 022 (design decision 7): Stripe's own limits, checked once while the runtime definition
  // initializes (runtime-context.ts) instead of leaking into ClientConfig's schema. Every message
  // names the config path and the fix, so a misconfigured deployment fails to start with something
  // actionable rather than 500ing on the first checkout.
  validateConfig(config: ClientConfig): void {
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
    const idempotencyKey = `bookkit-refund-${paymentRef}`;
    let created: Stripe.Refund;
    try {
      created = await this.stripe.refunds.create(
        { payment_intent: paymentRef, metadata: { bookkit_refund_key: idempotencyKey } },
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
        && candidate.metadata?.bookkit_refund_key === idempotencyKey
      ));
      return matched ? { refundRef: matched.id, amountMinor: expectedAmountMinor } : null;
    } catch {
      // Listing is only reconciliation evidence; retain the original create failure if unavailable.
      return null;
    }
  }
}

export default StripeProvider;
