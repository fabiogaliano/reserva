import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { booking, config } from './fixtures';
import {
  StripeProvider,
  mapSessionStatus,
  mapStripeEvent,
  stripePaymentMethodTypes,
  type StripeClient,
} from '../src/providers/stripe';
import { resolveRouteConfig } from '../src/routes-manifest';

function makeClient() {
  const sessions = {
    create: vi.fn(async (_params: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_created', url: 'https://checkout.test/cs_created' })),
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
      create: vi.fn(async () => ({ id: 're_1', amount: 10000 })),
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
    }));
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
    expect(sessions.create).toHaveBeenCalledWith(expect.not.objectContaining({ custom_fields: expect.anything() }));
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
    }));
  });

  it('omits terms-of-service consent when termsOfService is none', async () => {
    const { client, sessions } = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client, termsOfService: 'none' });
    await provider.createCheckout(booking(), config);
    expect(sessions.create).toHaveBeenCalledWith(expect.not.objectContaining({ consent_collection: expect.anything() }));
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
    await expect(provider.refund('pi_1')).resolves.toEqual({ refundId: 're_1', amountCents: 10000 });
    expect(client.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1' },
      { idempotencyKey: 'bookkit-refund-pi_1' },
    );
  });

  it('reconciles an already-refunded error via refunds.list instead of surfacing a false failure', async () => {
    const client = {
      checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
      refunds: {
        create: vi.fn(async () => { throw new Error('Charge ch_1 has already been refunded.'); }),
        list: vi.fn(async () => ({ data: [{ id: 're_existing', amount: 12000, status: 'succeeded' }] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1')).resolves.toEqual({ refundId: 're_existing', amountCents: 12000 });
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 5 });
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
        list: vi.fn(async () => ({ data: [{ id: 're_from_cache', amount: 9000, status: 'succeeded' }] })),
      },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient;
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.refund('pi_1')).resolves.toEqual({ refundId: 're_from_cache', amountCents: 9000 });
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 5 });
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
    await expect(provider.refund('pi_1')).rejects.toThrow('Your card was declined.');
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 5 });
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
    await expect(provider.refund('pi_1')).rejects.toThrow('Your card was declined.');
    expect(client.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 5 });
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
