import type { D1Database } from '@cloudflare/workers-types';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleCheckout } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';
import {
  StripeProvider,
  mapSessionStatus,
  mapStripeEvent,
  stripePaymentMethodTypes,
  type StripeClient,
} from '../src/providers/stripe';
import { resolveRouteConfig } from '../src/routes-manifest';

function stripeRefund(
  id: string,
  amount: number,
  options: { status?: string; metadata?: Record<string, string>; paymentIntent?: string } = {},
): Stripe.Refund {
  return {
    id,
    object: 'refund',
    amount,
    balance_transaction: null,
    charge: null,
    created: 0,
    currency: 'eur',
    metadata: options.metadata ?? {},
    payment_intent: options.paymentIntent ?? 'pi_1',
    reason: null,
    receipt_number: null,
    source_transfer_reversal: null,
    status: options.status ?? 'succeeded',
    transfer_reversal: null,
  };
}

function makeClient() {
  const sessions = {
    create: vi.fn(async (_params: Stripe.Checkout.SessionCreateParams, _options?: { idempotencyKey?: string }) => ({ id: 'cs_created', url: 'https://checkout.test/cs_created' })),
    retrieve: vi.fn(async () => ({
      id: 'cs_1',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 10000,
      currency: 'eur',
      payment_intent: 'pi_1',
      metadata: { bookingId: 'booking-1' },
      customer_details: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+351910000000' },
      custom_fields: [{ key: 'pickup_address', text: { value: 'Praça do Comércio' }, type: 'text' }],
    })),
  };
  const client = {
    checkout: { sessions },
    refunds: {
      create: vi.fn(async () => stripeRefund('re_1', 10000)),
      list: vi.fn(async () => ({ data: [] })),
    },
    webhooks: { constructEventAsync: vi.fn(async () => ({
      id: 'evt_1', type: 'checkout.session.completed', data: { object: {
        id: 'cs_1', metadata: { bookingId: 'booking-1' }, payment_intent: 'pi_1', amount_total: 10000, currency: 'eur', payment_status: 'paid',
        customer_details: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+351910000000' },
        custom_fields: [{ key: 'pickup_address', text: { value: 'Praça do Comércio' }, type: 'text' }],
      } },
    } as unknown as Stripe.Event)) },
  };
  return { client: client as unknown as StripeClient, sessions };
}

describe('StripeProvider', () => {
  it('creates a contract-compliant checkout session', async () => {
    const { client, sessions } = makeClient();
    const provider = new StripeProvider({
      secretKey: 'sk_test', webhookSecret: 'whsec_test', client,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      getTourName: (b) => `Vintage tour (${b.locale})`,
      getSuccessUrl: () => 'https://example.test/booking-confirmation?session_id={CHECKOUT_SESSION_ID}',
      getCancelUrl: (b) => `https://example.test/tours/${b.tourSlug}`,
    });
    await expect(provider.createCheckout(booking({ pickupType: 'custom' }), config)).resolves.toEqual({ url: 'https://checkout.test/cs_created', sessionId: 'cs_created' });
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment', expires_at: 1767227400, locale: 'en', payment_method_types: ['card', 'mb_way'],
      phone_number_collection: { enabled: true }, consent_collection: { terms_of_service: 'required' }, metadata: { bookingId: 'booking-1' },
      payment_intent_data: { metadata: { bookingId: 'booking-1' } },
      custom_fields: [{ key: 'pickup_address', label: { type: 'custom', custom: 'Pickup address' }, type: 'text' }],
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 12000, product_data: { name: 'Vintage tour (en)' } } }],
      // BK-PAY-002: every checkout.sessions.create call carries a deterministic idempotency key.
    }), { idempotencyKey: 'bookkit-checkout-booking-1' });
  });

  // BK-CONFIG-001: expiresInMinutes = max(30, holdMinutes - 5), so holdMinutes at its validateConfig
  // upper bound (1440) must still leave expires_at strictly below Stripe's 24h-from-creation cap —
  // the 5-minute margin is the whole point of capping holdMinutes at 1440 rather than 1445.
  it('keeps expires_at strictly below now + 24h when holdMinutes is at its 1440 upper bound', async () => {
    const { client, sessions } = makeClient();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client, now: () => now });
    const nowSec = Math.floor(now.getTime() / 1000);
    await provider.createCheckout(booking(), { ...config, booking: { ...config.booking, holdMinutes: 1440 } });
    const expiresAt = sessions.create.mock.calls[0]?.[0].expires_at;
    expect(expiresAt).toBe(nowSec + 1435 * 60);
    expect(expiresAt).toBeLessThan(nowSec + 24 * 60 * 60);
  });

  it('uses the resolved confirmation path for its default success URL and preserves the unprefixed fallback', async () => {
    const prefixed = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client: prefixed.client });
    await provider.createCheckout(booking(), config, resolveRouteConfig('/en').paths);
    const prefixedParams = prefixed.sessions.create.mock.calls[0]?.[0];
    expect(prefixedParams?.success_url).toContain('/en/booking-confirmation?session_id=');
    expect(prefixedParams?.success_url).not.toContain(`${config.business.url}/booking-confirmation?session_id=`);

    const unprefixed = makeClient();
    const fallbackProvider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client: unprefixed.client });
    await fallbackProvider.createCheckout(booking(), config);
    expect(unprefixed.sessions.create.mock.calls[0]?.[0].success_url).toContain('/booking-confirmation?session_id=');
  });

  it('omits pickup custom fields for the default pickup and supports positional construction', async () => {
    const { client, sessions } = makeClient();
    const provider = new StripeProvider('sk_test', 'whsec_test', { client });
    await provider.createCheckout(booking(), config);
    expect(sessions.create).toHaveBeenCalledWith(expect.not.objectContaining({ custom_fields: expect.anything() }), expect.anything());
  });

  it('adds a line-item description when productDescription is provided', async () => {
    const { client, sessions } = makeClient();
    const provider = new StripeProvider({
      secretKey: 'sk_test', webhookSecret: 'whsec_test', client,
      productDescription: (b) => `Tour of ${b.tourSlug} for ${b.people}`,
    });
    await provider.createCheckout(booking({ people: 4 }), config);
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [expect.objectContaining({ price_data: expect.objectContaining({
        product_data: expect.objectContaining({ description: 'Tour of vintage for 4' }),
      }) })],
    }), expect.anything());
  });

  it('omits terms-of-service consent when termsOfService is none', async () => {
    const { client, sessions } = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client, termsOfService: 'none' });
    await provider.createCheckout(booking(), config);
    expect(sessions.create).toHaveBeenCalledWith(expect.not.objectContaining({ consent_collection: expect.anything() }), expect.anything());
  });

  it('retrieves session status and performs a full refund', async () => {
    const { client } = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.getSession('cs_1')).resolves.toEqual({
      id: 'cs_1',
      status: 'complete',
      paymentStatus: 'paid',
      amountTotal: 10000,
      currency: 'eur',
      paymentIntent: 'pi_1',
      metadata: { bookingId: 'booking-1' },
      customerName: 'Ada Lovelace',
      customerEmail: 'ada@example.com',
      customerPhone: '+351910000000',
      pickupAddress: 'Praça do Comércio',
    });
    await expect(provider.refund('pi_1', 10000)).resolves.toEqual({ refundId: 're_1', amountCents: 10000 });
    expect(client.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', metadata: { bookkit_refund_key: 'bookkit-refund-pi_1' } },
      { idempotencyKey: 'bookkit-refund-pi_1' },
    );
  });

  it('rejects a directly created refund whose amount differs from the expected full amount', async () => {
    const { client } = makeClient();
    client.refunds.create = vi.fn(async () => stripeRefund('re_overpaid', 12000));
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Stripe refund amount 12000 did not match expected total 10000');
    expect(client.refunds.list).not.toHaveBeenCalled();
  });

  // The status check (src/providers/stripe.ts refund(), ~line 376) runs on a *resolved* create()
  // call, before the amount check and entirely outside the try/catch that drives reconciliation —
  // so a non-'succeeded' status must reject immediately, without ever consulting refunds.list.
  it('rejects a directly created refund whose status did not succeed, without reconciling', async () => {
    const { client } = makeClient();
    client.refunds.create = vi.fn(async () => stripeRefund('re_pending', 10000, { status: 'pending' }));
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Stripe refund re_pending did not succeed (status pending)');
    expect(client.refunds.list).not.toHaveBeenCalled();
  });

  it('reconciles an already-refunded error via refunds.list instead of surfacing a false failure', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Charge ch_1 has already been refunded.'); }),
        list: vi.fn(async () => ({ data: [stripeRefund('re_existing', 10000, { metadata: { bookkit_refund_key: 'bookkit-refund-pi_1' } })] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).resolves.toEqual({ refundId: 're_existing', amountCents: 10000 });
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
  });

  // BK-REFUND-001 (finding #6): Stripe replays a cached idempotent result *including* error
  // responses, even a cached 500 unrelated to refunds by message — so gating reconciliation on an
  // "already refunded" message match (the pre-fix behaviour) misses exactly the caveat-(b)
  // scenario this test drives: a generic/opaque error whose underlying refund actually succeeded.
  it('reconciles a replayed cached error via refunds.list even when the error message does not mention a refund', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Request failed with status code 500'); }),
        list: vi.fn(async () => ({ data: [stripeRefund('re_from_cache', 10000, { metadata: { bookkit_refund_key: 'bookkit-refund-pi_1' } })] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).resolves.toEqual({ refundId: 're_from_cache', amountCents: 10000 });
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
  });

  it('does not reconcile a historical partial refund as this request’s full refund', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Request failed with status code 500'); }),
        list: vi.fn(async () => ({ data: [stripeRefund('re_partial', 2000, { metadata: { bookkit_refund_key: 'other-request' } })] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Request failed with status code 500');
  });

  it('does not reconcile an unrelated historical full refund without this request’s marker', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Request failed with status code 500'); }),
        list: vi.fn(async () => ({ data: [stripeRefund('re_other_full', 10000)] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Request failed with status code 500');
  });

  it('does not reconcile a marked partial refund by adding a historical partial', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Request failed with status code 500'); }),
        list: vi.fn(async () => ({ data: [
          stripeRefund('re_marked_partial', 8000, { metadata: { bookkit_refund_key: 'bookkit-refund-pi_1' } }),
          stripeRefund('re_historical_partial', 2000, { metadata: { source: 'dashboard' } }),
        ] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Request failed with status code 500');
  });

  it('does not treat a pending/failed refund on file as success-equivalent — the original error still surfaces', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Your card was declined.'); }),
        list: vi.fn(async () => ({ data: [{ id: 're_pending', amount: 12000, status: 'pending' }] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Your card was declined.');
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
  });

  it('surfaces a genuine refund failure unchanged when no successful refund is on file', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Your card was declined.'); }),
        list: vi.fn(async () => ({ data: [] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Your card was declined.');
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
  });

  it('preserves the create failure when reconciliation cannot be queried', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Stripe create response was lost'); }),
        list: vi.fn(async () => { throw new Error('Stripe refund list unavailable'); }),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Stripe create response was lost');
  });

  // charge_already_refunded: Stripe's 400 rejection when a refund actually succeeded on an
  // earlier attempt whose response was lost, and the idempotency key later aged out of Stripe's
  // ~24h cache, so the retry lands as a fresh create() against an already-refunded charge. Unlike
  // other StripeInvalidRequestError codes this one still gets a reconciliation pass before
  // rethrowing — see isChargeAlreadyRefundedError in src/providers/stripe.ts.
  it('reconciles a charge_already_refunded StripeInvalidRequestError via refunds.list', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => {
          throw new Stripe.errors.StripeInvalidRequestError({ message: 'Charge ch_1 has already been refunded.', code: 'charge_already_refunded' });
        }),
        list: vi.fn(async () => ({ data: [stripeRefund('re_recovered', 10000, { metadata: { bookkit_refund_key: 'bookkit-refund-pi_1' } })] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).resolves.toEqual({ refundId: 're_recovered', amountCents: 10000 });
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
  });

  it('rethrows the original charge_already_refunded error when no matching refund is on file', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => {
          throw new Stripe.errors.StripeInvalidRequestError({ message: 'Charge ch_1 has already been refunded.', code: 'charge_already_refunded' });
        }),
        // Wrong amount and no bookkit_refund_key marker — not proof this request's refund succeeded.
        list: vi.fn(async () => ({ data: [stripeRefund('re_unrelated', 4000)] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Charge ch_1 has already been refunded.');
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
  });

  it('throws a StripeInvalidRequestError with a different code immediately, without reconciliation', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => {
          throw new Stripe.errors.StripeInvalidRequestError({ message: 'No such payment_intent', code: 'resource_missing' });
        }),
        list: vi.fn(),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('No such payment_intent');
    expect(client.refunds.list).not.toHaveBeenCalled();
  });

  it('throws a StripeCardError immediately, without reconciliation', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => {
          throw new Stripe.errors.StripeCardError({ message: 'Your card was declined.' });
        }),
        list: vi.fn(),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1', 10000)).rejects.toThrow('Your card was declined.');
    expect(client.refunds.list).not.toHaveBeenCalled();
  });

  it('rejects missing webhook signatures with a typed client error', async () => {
    const { client } = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.parseWebhook(new Request('https://example.test/webhook', { method: 'POST', body: '{}' })))
      .rejects.toMatchObject({ status: 400, code: 'invalid_stripe_signature' });
  });

  it('passes the raw webhook body through subtle verification and maps it', async () => {
    const { client } = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    const request = new Request('https://example.test/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: '{"raw":true}' });
    await expect(provider.parseWebhook(request)).resolves.toMatchObject({
      id: 'evt_1',
      bookingId: 'booking-1',
      sessionId: 'cs_1',
      paymentIntent: 'pi_1',
      amountCaptured: 10000,
      paid: true,
      currency: 'eur',
      paymentStatus: 'paid',
      customerName: 'Ada Lovelace',
      customerEmail: 'ada@example.com',
      customerPhone: '+351910000000',
      pickupAddress: 'Praça do Comércio',
    });
    expect(client.webhooks.constructEventAsync).toHaveBeenCalledWith('{"raw":true}', 't=1,v1=x', 'whsec_test', 300, expect.anything());
  });
});

// BK-PAY-002: a lost checkout.sessions.create response used to make handleCheckout expire the
// hold and let the client retry into a second, orphaned Stripe session for the same intent-to-
// book. These tests pin the fix: a deterministic per-hold idempotency key, a retry-once that
// reuses byte-identical params (so Stripe replays instead of 409ing), and unchanged expire-on-
// error behavior for rejections a retry could never turn into a success.
describe('Checkout idempotency (BK-PAY-002)', () => {
  const checkoutRequest = (start = '2026-06-15T08:00:00.000Z') => new Request('https://example.test/api/booking/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tourSlug: 'vintage', start, people: 2, pickupType: 'default', locale: 'en' }),
  });

  it('derives a checkout idempotency key from the booking id: stable for the same booking, distinct across bookings', async () => {
    const { client, sessions } = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await provider.createCheckout(booking({ id: 'booking-1' }), config);
    await provider.createCheckout(booking({ id: 'booking-1' }), config);
    await provider.createCheckout(booking({ id: 'booking-2' }), config);
    const keys = sessions.create.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(keys).toEqual(['bookkit-checkout-booking-1', 'bookkit-checkout-booking-1', 'bookkit-checkout-booking-2']);
  });

  it('retries once with the same idempotency key and byte-identical params after an ambiguous (network-ish) failure, replaying the original session', async () => {
    // Deep snapshots (not the live `params` reference) per call: the provider reuses the same
    // object across both attempts, so pushing the reference itself would make paramsPerCall[0]
    // and [1] literally the same object — always "equal" no matter what a drifting implementation
    // did to it. A structuredClone freezes what each call actually saw at the time it was made.
    const paramsPerCall: Stripe.Checkout.SessionCreateParams[] = [];
    let original: { id: string; url: string } | null = null;
    const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams, options?: { idempotencyKey?: string }) => {
      paramsPerCall.push(structuredClone(params));
      if (!original) {
        // Simulates Stripe having actually accepted/created the session but the response
        // getting lost (timeout/connection drop) before it reached the caller.
        original = { id: 'cs_original', url: 'https://checkout.test/cs_original' };
        throw new TypeError('fetch failed');
      }
      // A real Stripe retry only replays the cached session when the key AND params match the
      // original request exactly; assert that here too, not just that a key was supplied.
      expect(options?.idempotencyKey).toBe('bookkit-checkout-booking-1');
      expect(params).toEqual(paramsPerCall[0]);
      return original;
    });
    const client = {
      checkout: { sessions: { create, retrieve: vi.fn() } },
      refunds: { create: vi.fn(), list: vi.fn() },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    // An advancing clock, not a frozen one: expires_at is derived from `now`, so if a future
    // regression rebuilt params on retry (re-invoking `now`), a frozen clock could land the retry
    // in the same second and hide the drift. Each call to `now` here returns a later time, so any
    // recompute would produce a strictly later expires_at and be caught by the equality checks below.
    let tick = 0;
    const now = () => new Date('2026-06-15T08:00:00.000Z').getTime() + (tick++) * 60_000;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client, now });

    await expect(provider.createCheckout(booking(), config)).resolves.toEqual({
      url: 'https://checkout.test/cs_original', sessionId: 'cs_original',
    });
    expect(create).toHaveBeenCalledTimes(2);
    // Param drift (e.g. a recomputed expires_at) would make a real Stripe retry 409 instead of
    // replaying — pin exact equality, not just that both calls happened to succeed.
    expect(paramsPerCall[1]).toEqual(paramsPerCall[0]);
    expect(paramsPerCall[1]?.expires_at).toBe(paramsPerCall[0]?.expires_at);
    expect(create.mock.calls[0]?.[1]).toEqual({ idempotencyKey: 'bookkit-checkout-booking-1' });
    expect(create.mock.calls[1]?.[1]).toEqual({ idempotencyKey: 'bookkit-checkout-booking-1' });
  });

  it('handleCheckout: an ambiguous createCheckout failure that recovers on retry does not expire the hold, and stripeSessionId lands on the booking', async () => {
    let original: { id: string; url: string } | null = null;
    const create = vi.fn(async (_params: Stripe.Checkout.SessionCreateParams, _options?: { idempotencyKey?: string }) => {
      if (!original) {
        original = { id: 'cs_recovered', url: 'https://checkout.test/cs_recovered' };
        throw new TypeError('fetch failed');
      }
      return original;
    });
    const client = {
      checkout: { sessions: { create, retrieve: vi.fn() } },
      refunds: { create: vi.fn(), list: vi.fn() },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    const repo = fakeRepository();
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ payments: provider }),
    });

    const response = await handleCheckout(checkoutRequest(), context);
    expect(response.status).toBe(201);
    const body = await response.json() as { bookingId: string };
    const stored = repo.rows.get(body.bookingId);
    expect(stored?.status).toBe('hold');
    expect(stored?.stripeSessionId).toBe('cs_recovered');
  });

  it('handleCheckout: a definitive Stripe rejection is not retried, and the hold IS still expired (pinned behavior)', async () => {
    // Declared with the real create() parameter list (even though it always throws) so the mock's
    // inferred type keeps both positional args and .mock.calls[n][1] type-checks below.
    const create = vi.fn(async (_params: Stripe.Checkout.SessionCreateParams, _options?: { idempotencyKey?: string }): Promise<Stripe.Checkout.Session> => {
      throw new Stripe.errors.StripeInvalidRequestError({ message: 'Invalid locale' });
    });
    const client = {
      checkout: { sessions: { create, retrieve: vi.fn() } },
      refunds: { create: vi.fn(), list: vi.fn() },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    const repo = fakeRepository();
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ payments: provider }),
    });

    const response = await handleCheckout(checkoutRequest(), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    // Exactly one attempt: Stripe would replay the same cached rejection on a retry, so retrying
    // buys nothing and the hold is expired immediately instead.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ idempotencyKey: expect.stringMatching(/^bookkit-checkout-/) });
    expect([...repo.rows.values()]).toHaveLength(1);
    expect([...repo.rows.values()].every((row) => row.status === 'expired')).toBe(true);
  });

  it('handleCheckout: a 409 idempotency_error (same key, conflicting params) is not retried, and the hold IS still expired', async () => {
    const create = vi.fn(async (_params: Stripe.Checkout.SessionCreateParams, _options?: { idempotencyKey?: string }): Promise<Stripe.Checkout.Session> => {
      throw new Stripe.errors.StripeIdempotencyError({ message: 'Keys for idempotent requests can only be used with the same parameters as they were first used with' });
    });
    const client = {
      checkout: { sessions: { create, retrieve: vi.fn() } },
      refunds: { create: vi.fn(), list: vi.fn() },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    const repo = fakeRepository();
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ payments: provider }),
    });

    const response = await handleCheckout(checkoutRequest(), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    // A retry would resend the same params under the same key and 409 again, so it is skipped —
    // exactly one create() call — and the hold is expired immediately instead.
    expect(create).toHaveBeenCalledTimes(1);
    expect([...repo.rows.values()]).toHaveLength(1);
    expect([...repo.rows.values()].every((row) => row.status === 'expired')).toBe(true);
  });
});

describe('Stripe mapping helpers', () => {
  it('maps payment methods and full-refund charge amounts', () => {
    expect(stripePaymentMethodTypes(['card', 'mb_way'])).toEqual(['card', 'mb_way']);
    expect(mapStripeEvent({ id: 'evt_refund', type: 'charge.refunded', data: { object: {
      metadata: { bookingId: 'booking-1' }, payment_intent: { id: 'pi_1' }, amount_captured: 10000, amount_refunded: 10000,
      refunds: { data: [{ id: 're_1' }] },
    } } } as unknown as Stripe.Event)).toMatchObject({ bookingId: 'booking-1', paymentIntent: 'pi_1', amountCaptured: 10000, amountRefunded: 10000, refundId: 're_1' });
  });

  it('maps a session to the public status shape', () => {
    expect(mapSessionStatus({ id: 'cs_1', status: 'open', payment_status: 'unpaid', amount_total: 10000, currency: 'eur', payment_intent: null, metadata: null } as Stripe.Checkout.Session)).toEqual({ id: 'cs_1', status: 'open', paymentStatus: 'unpaid', amountTotal: 10000, currency: 'eur', paymentIntent: null });
  });
});
