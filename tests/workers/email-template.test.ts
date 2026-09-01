import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PaymentEventParsed } from '../../src/core/events';
import { renderDefaultEmail, type EmailRenderer, type EmailTemplateContext } from '../../src/email';
import { handlePaymentWebhook } from '../../src/handlers';
import { createBookingRepository } from '../../src/repo';
import { defineCloudflareReservaRuntime, type ReservaProviders } from '../../src/runtime';
import { booking as bookingFixture, config as baseConfig } from '../fixtures';

// A from-scratch, non-Brevo transport that imports `renderDefaultEmail` through
// `@reservajs/astro/email` (`../../src/email` resolves the exact same module a consumer's
// `@reservajs/astro/email` specifier resolves to), overrides exactly one event, and delegates
// every other event -- including the one this test round-trips through a real confirmation
// against real D1 -- to the shipped default template. Proves the public seam is enough to build a
// working provider without touching src/providers/email-brevo/index.ts at all.

interface TestEnv { RESERVA_DB: D1Database }
const db = (env as unknown as TestEnv).RESERVA_DB;
const repo = createBookingRepository(db);

function manageUrl(token: string): string {
  return `https://example.test/booking/manage?token=${encodeURIComponent(token)}`;
}

const fakeTransportRenderer: EmailRenderer = (context) => {
  if (context.event === 'booking.no_show') {
    return { subject: 'We missed you today', html: '<p>custom no-show copy, not the shipped default</p>' };
  }
  return renderDefaultEmail(context);
};

let rendered: Array<{ event: string; recipient: string; subject: string; html: string }> = [];

const fakeEmailProvider: NonNullable<ReservaProviders['email']> = {
  recipientsForEvent(event) {
    return event === 'booking.confirmed' ? ['customer', 'owner'] : ['customer'];
  },
  async sendToRecipient(recipient, event, booking) {
    const context: EmailTemplateContext = {
      event, booking, config: baseConfig, locale: booking.locale, recipient,
      customerManageUrl: manageUrl(booking.cancelToken), operatorManageUrl: manageUrl(booking.operatorToken),
      startsAtLocal: new Date(booking.startsAt).toISOString(),
    };
    const content = fakeTransportRenderer(context);
    rendered.push({ event, recipient, subject: content.subject, html: content.html });
  },
  async send(event, booking) {
    await this.sendToRecipient!('customer', event, booking, baseConfig);
  },
};

const providers: ReservaProviders = {
  payments: {
    createCheckout: async () => ({ url: '', sessionRef: '' }),
    parseWebhook: async (request) => (await request.json()) as PaymentEventParsed,
    getSession: async () => ({ status: 'open' }),
    refund: async () => ({ refundRef: 're_email_template_test', amountMinor: 0 }),
  },
  calendar: {
    async listEvents() { return []; },
    async createEvent() { return 'cal_email_template_test'; },
    async patchEvent() { /* not exercised */ },
    async deleteEvent() { /* not exercised */ },
  },
  email: fakeEmailProvider,
};

const runtime = defineCloudflareReservaRuntime(baseConfig, { providers });

function buildContext(request: Request) {
  return runtime.createContext({ request, locals: { env: { RESERVA_DB: db } } });
}

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  rendered = [];
});

describe('a non-Brevo fake provider built on renderDefaultEmail (plan 026 step 5)', () => {
  it('delegates booking.confirmed to renderDefaultEmail and round-trips a real confirmation through real D1', async () => {
    const now = new Date().toISOString();
    const seeded = await repo.insertHold({
      id: 'email-template-1', reference: 'ETP-2026-001', serviceSlug: 'vintage', quantity: 2,
      pickupType: 'default',
      startsAt: futureIso(30 * 24 * 60 * 60_000), endsAt: futureIso(30 * 24 * 60 * 60_000 + 60 * 60_000),
      locale: 'en', priceMinor: 10000, currency: 'eur', holdExpiresAt: futureIso(60 * 60_000),
      cancelToken: 'email-template-1-cancel', operatorToken: 'email-template-1-operator',
      createdAt: now, updatedAt: now,
    });

    const payload = JSON.stringify({
      id: 'evt_email_template_1', type: 'checkout_completed', bookingId: seeded.id, sessionRef: 'sess_email_template_1',
      paymentRef: 'pay_email_template_1', paid: true, amountCaptured: 10000, currency: 'eur',
    } satisfies PaymentEventParsed);

    const context = await buildContext(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST', body: payload }));
    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST', body: payload }), context);
    expect(response.status).toBe(200);

    const confirmed = await repo.getBookingById(seeded.id);
    expect(confirmed?.status).toBe('confirmed');

    const confirmedEmails = rendered.filter((entry) => entry.event === 'booking.confirmed');
    expect(confirmedEmails.map((entry) => entry.recipient).sort()).toEqual(['customer', 'owner']);
    const customerEmail = confirmedEmails.find((entry) => entry.recipient === 'customer');
    // This is renderDefaultEmail's real, current output -- not a mock -- since the fake provider
    // only overrides booking.no_show and delegates every other event.
    expect(customerEmail?.subject).toContain('Booking confirmed');
    expect(customerEmail?.html).toContain('we look forward to seeing you');
    expect(customerEmail?.html).toEqual(renderDefaultEmail({
      event: 'booking.confirmed', booking: confirmed!, config: baseConfig, locale: 'en', recipient: 'customer',
      customerManageUrl: manageUrl(confirmed!.cancelToken), operatorManageUrl: manageUrl(confirmed!.operatorToken),
      startsAtLocal: new Date(confirmed!.startsAt).toISOString(),
    }).html);
  });

  it('overrides booking.no_show instead of delegating', () => {
    const context: EmailTemplateContext = {
      event: 'booking.no_show', booking: bookingFixture(), config: baseConfig, locale: 'en', recipient: 'customer',
      customerManageUrl: '', operatorManageUrl: '', startsAtLocal: '',
    };
    expect(fakeTransportRenderer(context)).toEqual({ subject: 'We missed you today', html: '<p>custom no-show copy, not the shipped default</p>' });
    expect(fakeTransportRenderer(context)).not.toEqual(renderDefaultEmail(context));
  });
});
