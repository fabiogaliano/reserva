import Stripe from 'stripe';
import {
  pickupOptionFor,
  priceFor,
  requestText,
  resolveService,
  PAYMENT_WEBHOOK_BODY_LIMIT_BYTES,
  type ApiErrorCode,
  type Booking,
  type ClientConfig,
  type PaymentEventParsed,
  type PaymentProvider,
  type SessionStatus,
} from '@reservajs/astro/core';
import type { ReservaResolvedRouteConfig } from '@reservajs/astro';

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

export interface StripeOptions {
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
  // Shown under the name on Stripe's hosted checkout line item. Omitted when unset so the
  // checkout stays name-only.
  productDescription?: string | BookingCallback<string>;
  pickupFieldLabel?: string | BookingCallback<string>;
  // Payment methods are adapter configuration, not a Reserva setting — the accepted set is
  // Stripe's, changing it needs a Stripe dashboard capability, and no other provider shares the
  // vocabulary. Defaults to card-only.
  paymentMethods?: StripePaymentMethod[];
  // Stripe rejects consent collection unless the account has a Terms of Service URL in its
  // public business details, which a not-yet-activated test account lacks. Defaults to
  // 'required' to keep the chargeback-defense consent record; set 'none' for such an account.
  termsOfService?: 'required' | 'none';
}

export type StripePaymentMethod = 'card' | 'mb_way';

const DEFAULT_PAYMENT_METHODS: readonly StripePaymentMethod[] = ['card'];

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
// entry is the refund this event is about. Absent in some API versions/payloads, hence the
// optional chaining — falls back to no refund id rather than throwing.
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

// Definitive errors were rejected on their merits, so retrying the same idempotency key would
// just replay the rejection — a 409 conflict counts too, since this provider always resends
// identical params, meaning another request already used that key. Everything else is ambiguous
// and worth one retry.
function isDefinitiveStripeError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeCardError
    || error instanceof Stripe.errors.StripeInvalidRequestError
    || error instanceof Stripe.errors.StripeAuthenticationError
    || error instanceof Stripe.errors.StripePermissionError
    || error instanceof Stripe.errors.StripeIdempotencyError;
}

// `charge_already_refunded` happens when the idempotency key that would have replayed the
// original success has aged out (~24h) and the retry lands as a fresh request against an
// already-refunded charge — the money moved on the earlier attempt, so this is worth
// reconciling (exact amount + this request's marker) before rethrowing as definitive.
function isChargeAlreadyRefundedError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'charge_already_refunded';
}

function defaultSuccessUrl(config: ClientConfig, routePaths?: ReservaResolvedRouteConfig['paths']): string {
  return `${config.business.url.replace(/\/$/, '')}${routePaths?.confirmationPage ?? '/booking-confirmation'}?session_id=${checkoutSessionPlaceholder}`;
}

function defaultCancelUrl(booking: Booking, config: ClientConfig): string {
  return `${config.business.url.replace(/\/$/, '')}/services/${booking.serviceSlug}`;
}

export function stripePaymentMethodTypes(methods: readonly StripePaymentMethod[]): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] {
  return [...methods] as Stripe.Checkout.SessionCreateParams.PaymentMethodType[];
}


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


// An event Reserva has no name for keeps Stripe's own string and is ignored downstream.
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


// Constructed only through the `stripe(options)` factory; the class itself is never part of
// the published surface.
export class StripeProvider implements PaymentProvider {
  readonly stripe: StripeClient;
  readonly webhookSecret: string;
  private readonly now: () => Date | number;
  private readonly options: StripeOptions;

  constructor(options: StripeOptions) {
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
    routePaths?: ReservaResolvedRouteConfig['paths'],
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
    // Keyed off the service's declared option instead of a fixed 'custom' id, so any option
    // marked requiresAddress collects the field. A stored pickupType the service no longer
    // declares resolves to undefined, safely skipping the field rather than guessing.
    if (pickupOptionFor(service, booking.pickupType)?.requiresAddress) params.custom_fields = [{
      key: 'pickup_address', label: { type: 'custom', custom: pickupLabel }, type: 'text',
    }];
    if ((this.options.termsOfService ?? 'required') === 'required') {
      params.consent_collection = { terms_of_service: 'required' };
    }
    // A deterministic key per hold (not per call) so a lost response and a retried call both
    // land on the same Stripe session instead of minting a second, orphaned one.
    const idempotencyKey = `reserva-checkout-${booking.id}`;
    const session = await this.createSession(params, idempotencyKey);
    if (!session.url) throw new Error('Stripe Checkout Session did not include a URL');
    return { url: session.url, sessionRef: session.id };
  }

  // Stripe only replays the cached response for a reused idempotency key when the retry carries
  // byte-identical params (otherwise it 409s) — reusing the same `params` object reference
  // guarantees that. A retry is skipped for errors that were actually rejected, not ambiguous.
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
    // Read outside the try: an oversized body must surface as HttpError(413), not collapse into
    // a generic verification error. The text is passed to constructEventAsync unchanged, since
    // Stripe's signature was computed over these exact bytes — re-serializing would break it.
    const payload = await requestText(request, PAYMENT_WEBHOOK_BODY_LIMIT_BYTES);
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

  // Stripe's own limits, checked once at runtime init instead of leaking into ClientConfig's
  // schema. Every message names the config path and the fix, so a misconfigured deployment
  // fails to start with something actionable rather than 500ing on the first checkout.
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
    // This marker is persisted on the Stripe Refund object and is the only evidence
    // findExistingRefund can match after a crash mid-create — its shape is an external contract.
    // A refund under a changed marker shape surfaces as an operator incident, not a silent
    // double refund.
    const idempotencyKey = `reserva-refund-${paymentRef}`;
    let created: Stripe.Refund;
    try {
      created = await this.stripe.refunds.create(
        { payment_intent: paymentRef, metadata: { reserva_refund_key: idempotencyKey } },
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
