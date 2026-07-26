import Stripe from 'stripe';
import type { Booking } from '../core/booking';
import type { ClientConfig } from '../core/config';
import { resolveTour } from '../core/config';
import type { PaymentProvider, SessionStatus, StripeEventParsed } from '../core/events';
import { priceFor } from '../core/pricing';
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
  getTourName?: BookingCallback<string>;
  tourName?: BookingCallback<string>;
  getProductName?: BookingCallback<string>;
  productName?: BookingCallback<string>;
  getLineItemName?: BookingCallback<string>;
  // Shown under the name on Stripe's hosted checkout line item. Omitted when
  // unset so the checkout stays name-only, matching prior behaviour.
  productDescription?: string | BookingCallback<string>;
  pickupFieldLabel?: string | BookingCallback<string>;
  // Stripe rejects consent collection unless the account has a Terms of Service
  // URL in its public business details, which a not-yet-activated test account
  // lacks. Defaults to 'required' so operators keep the chargeback-defense
  // consent record; set 'none' to run against such an account.
  termsOfService?: 'required' | 'none';
}

type PositionalOptions = Omit<StripeProviderOptions, 'secretKey' | 'webhookSecret'>;

export class StripeWebhookVerificationError extends Error {
  readonly status = 400;
  readonly code = 'invalid_stripe_signature';

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
function isDefinitiveStripeError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeCardError
    || error instanceof Stripe.errors.StripeInvalidRequestError
    || error instanceof Stripe.errors.StripeAuthenticationError
    || error instanceof Stripe.errors.StripePermissionError
    || error instanceof Stripe.errors.StripeIdempotencyError;
}

function defaultSuccessUrl(config: ClientConfig, routePaths?: BookkitResolvedRouteConfig['paths']): string {
  return `${config.business.url.replace(/\/$/, '')}${routePaths?.confirmationPage ?? '/booking-confirmation'}?session_id=${checkoutSessionPlaceholder}`;
}

function defaultCancelUrl(booking: Booking, config: ClientConfig): string {
  return `${config.business.url.replace(/\/$/, '')}/tours/${booking.tourSlug}`;
}

export function stripePaymentMethodTypes(methods: ClientConfig['payments']['methods']): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] {
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
    paymentIntent: objectId(session.payment_intent),
    ...customerDetailsOf(session),
    ...(metadata ? { metadata } : {}),
  };
}

export const mapSessionStatus = sessionStatusFromStripe;

export function stripeEventToParsed(event: Stripe.Event): StripeEventParsed {
  const object = event.data.object as unknown;
  const parsed: StripeEventParsed = { id: event.id, type: event.type, raw: event };
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
    const session = object as Stripe.Checkout.Session;
    const bookingId = bookingIdOf(session);
    const paymentIntent = objectId(session.payment_intent);
    const amountCaptured = amountOf(session, 'amount_total');
    Object.assign(parsed, customerDetailsOf(session));
    if (bookingId) parsed.bookingId = bookingId;
    if (session.id) parsed.sessionId = session.id;
    if (paymentIntent) parsed.paymentIntent = paymentIntent;
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
    if (paymentIntent) parsed.paymentIntent = paymentIntent;
    if (amountCaptured !== undefined) parsed.amountCaptured = amountCaptured;
    if (amountRefunded !== undefined) parsed.amountRefunded = amountRefunded;
    if (refundId !== undefined) parsed.refundId = refundId;
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
  ): Promise<{ url: string; sessionId: string }> {
    const tour = resolveTour(config, booking.tourSlug);
    const nameCallback = this.options.getTourName
      ?? this.options.tourName
      ?? this.options.getProductName
      ?? this.options.productName
      ?? this.options.getLineItemName;
    const name = resolveOption(nameCallback, booking, config, booking.tourSlug);
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
        unit_amount: priceFor(tour, booking.people, booking.pickupType),
        product_data: { name, ...(description ? { description } : {}) },
      } }],
      expires_at: Math.floor(nowMs(this.now) / 1000) + expiresInMinutes * 60,
      locale: booking.locale as Stripe.Checkout.SessionCreateParams.Locale,
      payment_method_types: stripePaymentMethodTypes(config.payments.methods),
      phone_number_collection: { enabled: true },
      metadata: { bookingId: booking.id },
      payment_intent_data: { metadata: { bookingId: booking.id } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    };
    if (booking.pickupType === 'custom') params.custom_fields = [{
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
    return { url: session.url, sessionId: session.id };
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

  async parseWebhook(request: Request): Promise<StripeEventParsed> {
    const signature = request.headers.get('stripe-signature');
    if (!signature) throw new StripeWebhookVerificationError();
    try {
      const event = await this.stripe.webhooks.constructEventAsync(
        await request.text(), signature, this.webhookSecret, 300, Stripe.createSubtleCryptoProvider(),
      );
      return stripeEventToParsed(event);
    } catch {
      throw new StripeWebhookVerificationError();
    }
  }

  async getSession(sessionId: string): Promise<SessionStatus> {
    return sessionStatusFromStripe(await this.stripe.checkout.sessions.retrieve(sessionId));
  }

  async refund(paymentIntent: string, expectedAmountCents: number): Promise<{ refundId: string; amountCents: number }> {
    const idempotencyKey = `bookkit-refund-${paymentIntent}`;
    let created: Stripe.Refund;
    try {
      created = await this.stripe.refunds.create(
        { payment_intent: paymentIntent, metadata: { bookkit_refund_key: idempotencyKey } },
        { idempotencyKey },
      );
    } catch (error) {
      if (isDefinitiveStripeError(error)) throw error;
      // A list result is proof of success only when the refund carries this request's marker and
      // its own amount is exact.
      const reconciled = await this.findExistingRefund(paymentIntent, expectedAmountCents, idempotencyKey);
      if (reconciled) return reconciled;
      throw error;
    }
    if (created.status !== 'succeeded') {
      throw new Error(`Stripe refund ${created.id} did not succeed (status ${created.status ?? 'unknown'})`);
    }
    if (created.amount !== expectedAmountCents) {
      throw new Error(`Stripe refund amount ${created.amount} did not match expected total ${expectedAmountCents}`);
    }
    return { refundId: created.id, amountCents: expectedAmountCents };
  }

  private async findExistingRefund(
    paymentIntent: string,
    expectedAmountCents: number,
    idempotencyKey: string,
  ): Promise<{ refundId: string; amountCents: number } | null> {
    try {
      const list = await this.stripe.refunds.list?.({ payment_intent: paymentIntent, limit: 100 });
      if (!list) return null;
      const matched = list.data.find((candidate) => (
        candidate.status === 'succeeded'
        && candidate.amount === expectedAmountCents
        && candidate.metadata?.bookkit_refund_key === idempotencyKey
      ));
      return matched ? { refundId: matched.id, amountCents: expectedAmountCents } : null;
    } catch {
      // Listing is only reconciliation evidence; retain the original create failure if unavailable.
      return null;
    }
  }
}

export default StripeProvider;
