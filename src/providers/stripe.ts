import Stripe from 'stripe';
import type { Booking } from '../core/booking';
import type { ClientConfig } from '../core/config';
import { resolveTour } from '../core/config';
import type { PaymentProvider, SessionStatus, StripeEventParsed } from '../core/events';
import { priceFor } from '../core/pricing';

export interface StripeClient {
  checkout: { sessions: {
    create(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session>;
    retrieve(sessionId: string): Promise<Stripe.Checkout.Session>;
  } };
  refunds: { create(params: Stripe.RefundCreateParams, options?: { idempotencyKey?: string }): Promise<Stripe.Refund> };
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
  pickupFieldLabel?: string | BookingCallback<string>;
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

function defaultSuccessUrl(config: ClientConfig): string {
  return `${config.business.url.replace(/\/$/, '')}/booking-confirmation?session_id=${checkoutSessionPlaceholder}`;
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
  return {
    id: session.id,
    status: session.status ?? 'unknown',
    paymentStatus: session.payment_status,
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
    if (event.type === 'checkout.session.completed') parsed.paid = session.payment_status === 'paid';
    return parsed;
  }
  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    const charge = object as { metadata?: Record<string, string> | null; paid?: boolean };
    const bookingId = bookingIdOf(charge);
    const paymentIntent = paymentIntentOf(charge);
    const amountCaptured = amountOf(charge, 'amount_captured');
    const amountRefunded = amountOf(charge, 'amount_refunded');
    if (bookingId) parsed.bookingId = bookingId;
    if (paymentIntent) parsed.paymentIntent = paymentIntent;
    if (amountCaptured !== undefined) parsed.amountCaptured = amountCaptured;
    if (amountRefunded !== undefined) parsed.amountRefunded = amountRefunded;
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

  async createCheckout(booking: Booking, config: ClientConfig): Promise<{ url: string; sessionId: string }> {
    const tour = resolveTour(config, booking.tourSlug);
    const nameCallback = this.options.getTourName
      ?? this.options.tourName
      ?? this.options.getProductName
      ?? this.options.productName
      ?? this.options.getLineItemName;
    const name = resolveOption(nameCallback, booking, config, booking.tourSlug);
    const successUrl = this.options.getSuccessUrl?.(booking, config)
      ?? resolveOption(this.options.successUrl, booking, config, defaultSuccessUrl(config));
    const cancelUrl = this.options.getCancelUrl?.(booking, config)
      ?? resolveOption(this.options.cancelUrl, booking, config, defaultCancelUrl(booking, config));
    const pickupLabel = resolveOption(this.options.pickupFieldLabel, booking, config, defaultPickupFieldLabel);
    const expiresInMinutes = Math.max(30, config.booking.holdMinutes - 5);
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: {
        currency: config.business.currency,
        unit_amount: priceFor(tour, booking.people, booking.pickupType),
        product_data: { name },
      } }],
      expires_at: Math.floor(nowMs(this.now) / 1000) + expiresInMinutes * 60,
      locale: booking.locale as Stripe.Checkout.SessionCreateParams.Locale,
      payment_method_types: stripePaymentMethodTypes(config.payments.methods),
      phone_number_collection: { enabled: true },
      consent_collection: { terms_of_service: 'required' },
      metadata: { bookingId: booking.id },
      payment_intent_data: { metadata: { bookingId: booking.id } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    };
    if (booking.pickupType === 'custom') params.custom_fields = [{
      key: 'pickup_address', label: { type: 'custom', custom: pickupLabel }, type: 'text',
    }];
    const session = await this.stripe.checkout.sessions.create(params);
    if (!session.url) throw new Error('Stripe Checkout Session did not include a URL');
    return { url: session.url, sessionId: session.id };
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

  async refund(paymentIntent: string): Promise<void> {
    await this.stripe.refunds.create(
      { payment_intent: paymentIntent },
      { idempotencyKey: `bookkit-refund-${paymentIntent}` },
    );
  }
}

export default StripeProvider;
