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

function makeClient() {
  const sessions = {
    create: vi.fn(async () => ({ id: 'cs_created', url: 'https://checkout.test/cs_created' })),
    retrieve: vi.fn(async () => ({
      id: 'cs_1',
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      metadata: { bookingId: 'booking-1' },
      customer_details: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+351910000000' },
      custom_fields: [{ key: 'pickup_address', text: { value: 'Praça do Comércio' }, type: 'text' }],
    })),
  };
  const client = {
    checkout: { sessions },
    refunds: { create: vi.fn(async () => ({ id: 're_1' })) },
    webhooks: { constructEventAsync: vi.fn(async () => ({
      id: 'evt_1', type: 'checkout.session.completed', data: { object: {
        id: 'cs_1', metadata: { bookingId: 'booking-1' }, payment_intent: 'pi_1', amount_total: 10000, payment_status: 'paid',
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

  it('omits pickup custom fields for the default pickup and supports positional construction', async () => {
    const { client, sessions } = makeClient();
    const provider = new StripeProvider('sk_test', 'whsec_test', { client });
    await provider.createCheckout(booking(), config);
    expect(sessions.create).toHaveBeenCalledWith(expect.not.objectContaining({ custom_fields: expect.anything() }));
  });

  it('retrieves session status and performs a full refund', async () => {
    const { client } = makeClient();
    const provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client });
    await expect(provider.getSession('cs_1')).resolves.toEqual({
      id: 'cs_1',
      status: 'complete',
      paymentStatus: 'paid',
      paymentIntent: 'pi_1',
      metadata: { bookingId: 'booking-1' },
      customerName: 'Ada Lovelace',
      customerEmail: 'ada@example.com',
      customerPhone: '+351910000000',
      pickupAddress: 'Praça do Comércio',
    });
    await provider.refund('pi_1');
    expect(client.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1' },
      { idempotencyKey: 'bookkit-refund-pi_1' },
    );
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
    } } } as unknown as Stripe.Event)).toMatchObject({ bookingId: 'booking-1', paymentIntent: 'pi_1', amountCaptured: 10000, amountRefunded: 10000 });
  });

  it('maps a session to the public status shape', () => {
    expect(mapSessionStatus({ id: 'cs_1', status: 'open', payment_status: 'unpaid', payment_intent: null, metadata: null } as Stripe.Checkout.Session)).toEqual({ id: 'cs_1', status: 'open', paymentStatus: 'unpaid', paymentIntent: null });
  });
});
