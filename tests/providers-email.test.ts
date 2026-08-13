import { describe, expect, it, vi } from 'vitest';
import type { ClientConfig, TourConfig } from '../src/core/config';
import { BrevoResponseError, brevoEmail, BREVO_TRANSACTIONAL_EMAIL_URL } from '../src/providers/brevo';
import { calendarInviteOnly } from '../src/providers/noop';
import { booking, config, tour } from './fixtures';
import { resolveRouteConfig } from '../src/routes-manifest';

// Plan 017 (design decision 4): a canonical (post-validateConfig-shaped) multi-point tour, built
// inline per the plan's "don't edit shared fixture files" rule — fixtures.ts stays a single-point
// `meetingPoint` shorthand tour so every other suite's byte-identical assertions keep holding.
const { meetingPoint: _meetingPoint, ...tourWithoutShorthand } = tour;
const multiPointTour: TourConfig = {
  ...tourWithoutShorthand,
  meetingPoints: [
    { id: 'default', label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' },
    { id: 'belem', label: 'Belém Tower', mapsUrl: 'https://maps.google.com/?q=Belem+Tower' },
  ],
};
const multiPointConfig: ClientConfig = { ...config, tours: { vintage: multiPointTour } };

// Plan 018 (design decision 8): a declared option with BOTH requiresAddress and usesMeetingPoint
// (Maze's combined custom pickup+drop-off) — built inline per the same "don't touch fixtures.ts" rule.
const bothFlagsTour: TourConfig = {
  ...multiPointTour,
  pickupOptions: [
    { id: 'default', requiresAddress: false, usesMeetingPoint: true },
    { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
    { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
  ],
  pricing: [
    { maxPeople: 8, pickup: 'default', priceCents: 18000 },
    { maxPeople: 8, pickup: 'custom_dropoff', priceCents: 21000 },
    { maxPeople: 8, pickup: 'custom_pickup', priceCents: 20000 },
  ],
};
const bothFlagsConfig: ClientConfig = { ...config, tours: { vintage: bothFlagsTour } };

describe('email providers', () => {
  it('posts localized customer and owner messages to Brevo', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'xkeysib-test', fetch: request });

    await provider.send('booking.confirmed', booking({ locale: 'pt-BR', pickupType: 'custom', pickupAddress: 'Hotel Avenida' }), config);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, BREVO_TRANSACTIONAL_EMAIL_URL, expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'api-key': 'xkeysib-test' }) }));
    const customer = JSON.parse(request.mock.calls[0]![1]!.body as string) as { subject: string; to: Array<{ email: string }>; htmlContent: string };
    const owner = JSON.parse(request.mock.calls[1]![1]!.body as string) as { subject: string; to: Array<{ email: string }>; htmlContent: string };
    expect(customer.subject).toContain('Reserva confirmada');
    expect(customer.to).toEqual([{ email: 'ada@example.test', name: 'Ada Lovelace' }]);
    expect(customer.htmlContent).toContain('cancel-token');
    expect(customer.htmlContent).toContain('Hotel Avenida');
    expect(owner.subject).toContain('Nova reserva');
    expect(owner.to[0]?.email).toBe('owner@example.test');
    expect(owner.htmlContent).toContain('operator-token');
  });

  it('uses the resolved manage path in emails and preserves the unprefixed fallback', async () => {
    const prefixedRequest = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    await brevoEmail({ apiKey: 'key', fetchImpl: prefixedRequest }).send(
      'booking.confirmed',
      booking(),
      config,
      resolveRouteConfig('/en').paths,
    );
    const prefixedBody = prefixedRequest.mock.calls.map((call) => String(call[1]?.body)).join('\n');
    expect(prefixedBody).toContain('/en/booking/manage?token=');
    expect(prefixedBody).not.toContain(`${config.business.url}/booking/manage?token=`);

    const fallbackRequest = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    await brevoEmail({ apiKey: 'key', fetchImpl: fallbackRequest }).send('booking.confirmed', booking(), config);
    expect(fallbackRequest.mock.calls.map((call) => String(call[1]?.body)).join('\n')).toContain('/booking/manage?token=');
  });

  it('uses a renderer callback and falls back to the configured locale', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const render = vi.fn(({ locale, recipient }) => ({ subject: `${locale}:${recipient}`, htmlContent: '<p>custom</p>' }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request, render });
    await provider.send('booking.reminder', booking({ locale: 'fr' }), config);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', recipient: 'customer' }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the configured default locale when Stripe stores auto', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });
    await expect(provider.send('booking.confirmed', booking({ locale: 'auto' }), config)).resolves.toBeUndefined();
    const customer = JSON.parse(request.mock.calls[0]![1]!.body as string) as { subject: string };
    expect(customer.subject).toContain('Booking confirmed');
  });

  it('is a safe no-op when email is intentionally disabled', async () => {
    await expect(calendarInviteOnly().send('booking.confirmed', booking(), config)).resolves.toBeUndefined();
  });

  it('reports the configured recipient roles and sends exactly one guarded recipient message', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const render = vi.fn(() => ({ subject: 'subject', htmlContent: '<p>content</p>' }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request, render });

    expect(provider.recipientsForEvent('booking.confirmed')).toEqual(['customer', 'owner']);
    expect(provider.recipientsForEvent('booking.cancelled_by_customer')).toEqual(['customer', 'owner']);
    expect(provider.recipientsForEvent('booking.cancelled_by_operator')).toEqual(['customer']);
    expect(provider.recipientsForEvent('booking.rescheduled')).toEqual(['customer']);
    expect(provider.recipientsForEvent('booking.no_show')).toEqual(['customer']);

    await provider.sendToRecipient('customer', 'booking.confirmed', booking({
      cancelToken: 'nohash:customer', operatorToken: 'nohash:operator',
    }), config);

    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0];
    const body = call?.[1]?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('Brevo request body was not serialized');
    expect(JSON.parse(body)).toMatchObject({ to: [{ email: 'ada@example.test', name: 'Ada Lovelace' }] });
    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'customer', customerManageUrl: '', operatorManageUrl: '',
    }));
  });

  it('caps a failed response body and exposes its status without retaining the full body', async () => {
    const body = 'x'.repeat(5_000);
    const provider = brevoEmail({ apiKey: 'key', fetch: async () => new Response(body, { status: 503 }) });
    let caught: unknown;
    try {
      await provider.sendToRecipient('customer', 'booking.confirmed', booking(), config);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrevoResponseError);
    if (!(caught instanceof BrevoResponseError)) throw new Error('Brevo request unexpectedly succeeded');
    expect(caught.status).toBe(503);
    expect(caught.message).toContain('x'.repeat(200));
    expect(caught.message).not.toContain('x'.repeat(201));
    // Plan 016 (design decision 2): a 5xx is transient (retryable); the outbox attempt cap
    // (src/confirmation.ts) reads this off any thrown BrevoResponseError without parsing status
    // out of the message.
    expect(caught.retryable).toBe(true);
  });

  it('classifies a 4xx Brevo rejection as permanent (not retryable)', async () => {
    const provider = brevoEmail({ apiKey: 'key', fetch: async () => new Response('bad api key', { status: 401 }) });
    let caught: unknown;
    try {
      await provider.sendToRecipient('customer', 'booking.confirmed', booking(), config);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrevoResponseError);
    if (!(caught instanceof BrevoResponseError)) throw new Error('Brevo request unexpectedly succeeded');
    expect(caught.status).toBe(401);
    expect(caught.retryable).toBe(false);
  });

  // BK-SEC-002 (patch-11-r1 LOW 1): a `nohash:`-prefixed token (src/repo.ts placeholderToken) is
  // what a DB-loaded booking's cancelToken/operatorToken looks like when there's no decryptable
  // blob to regenerate the real link from (no BOOKKIT_TOKEN_ENC_KEY, or a not-yet-backfilled
  // legacy row). Rendering it into a link would produce an href that 403s the instant it's
  // clicked; the manage-link paragraph should be omitted instead.
  it('omits the manage-link paragraph entirely (never renders a dead href) when a token is not presentable', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });
    await provider.send('booking.confirmed', booking({ cancelToken: 'nohash:11111111-1111-1111-1111-111111111111', operatorToken: 'nohash:22222222-2222-2222-2222-222222222222' }), config);

    expect(request).toHaveBeenCalledTimes(2);
    const customerHtml = JSON.parse(request.mock.calls[0]![1]!.body as string) as { htmlContent: string };
    const ownerHtml = JSON.parse(request.mock.calls[1]![1]!.body as string) as { htmlContent: string };
    expect(customerHtml.htmlContent).not.toContain('nohash:');
    expect(customerHtml.htmlContent).not.toContain('href=""');
    expect(customerHtml.htmlContent).not.toContain('Manage your booking');
    expect(ownerHtml.htmlContent).not.toContain('nohash:');
    expect(ownerHtml.htmlContent).not.toContain('href=""');
    expect(ownerHtml.htmlContent).not.toContain('Open operator actions');
    // The rest of the email is unaffected — only the dead link paragraph is gone.
    expect(customerHtml.htmlContent).toContain('Ada Lovelace');
  });

  // Plan 017 (design decision 4/7): the label/maps link now resolve per booking (chosen meeting
  // point id) instead of always reading the tour's single `meetingPoint` — the template variable
  // names stay {pickupDetails}/{pickupMapLink} (decision 7).
  it('renders the label and maps link for the meeting point the booking chose on a multi-point tour', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });

    await provider.sendToRecipient('customer', 'booking.confirmed', booking({
      meetingPointId: 'belem', meetingPointLabel: 'Belém Tower',
    }), multiPointConfig);

    const body = JSON.parse(request.mock.calls[0]![1]!.body as string) as { htmlContent: string };
    expect(body.htmlContent).toContain('Belém Tower');
    expect(body.htmlContent).toContain('https://maps.google.com/?q=Belem+Tower');
    expect(body.htmlContent).not.toContain('Praça do Comércio');
  });

  it('falls back to the stored label snapshot with no maps link when the booked meeting point id is no longer declared', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });

    await provider.sendToRecipient('customer', 'booking.confirmed', booking({
      meetingPointId: 'removed-point', meetingPointLabel: 'Old Fountain Square',
    }), multiPointConfig);

    const body = JSON.parse(request.mock.calls[0]![1]!.body as string) as { htmlContent: string };
    expect(body.htmlContent).toContain('Old Fountain Square');
    expect(body.htmlContent).not.toContain('Open map');
    expect(body.htmlContent).not.toContain('maps.google.com');
  });

  // Plan 018 (design decision 8): a non-default declared option that only collects an address
  // (requiresAddress: true, usesMeetingPoint: false) — pickupDetails is the address, no maps link.
  it('renders the collected address for a non-default option id with requiresAddress and no maps link', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });

    await provider.sendToRecipient('customer', 'booking.confirmed', booking({
      pickupType: 'custom_pickup', pickupAddress: 'Hotel Avenida',
    }), bothFlagsConfig);

    const body = JSON.parse(request.mock.calls[0]![1]!.body as string) as { htmlContent: string };
    expect(body.htmlContent).toContain('Pickup: <strong>Hotel Avenida</strong>');
    expect(body.htmlContent).not.toContain('Open map');
  });

  // Plan 018 (design decision 8): an option with BOTH flags (Maze's combined custom pickup +
  // drop-off) renders both — the collected address AND the chosen meeting point's maps link,
  // since the two gates (requiresAddress, usesMeetingPoint) are independent, not exclusive.
  it('renders both the address and the meeting-point maps link for an option with both flags', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });

    await provider.sendToRecipient('customer', 'booking.confirmed', booking({
      pickupType: 'custom_dropoff', pickupAddress: 'Hotel Avenida',
      meetingPointId: 'belem', meetingPointLabel: 'Belém Tower',
    }), bothFlagsConfig);

    const body = JSON.parse(request.mock.calls[0]![1]!.body as string) as { htmlContent: string };
    expect(body.htmlContent).toContain('Pickup: <strong>Hotel Avenida</strong>');
    expect(body.htmlContent).toContain('<a href="https://maps.google.com/?q=Belem+Tower">Open map</a>');
  });

  // Plan 017 done criterion: an existing single-point `meetingPoint` config renders byte-identical
  // output — no meetingPointId/-Label on the booking resolves to the tour's one declared point,
  // same as before this plan.
  it('renders the single declared meeting point unchanged for a single-point tour', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });

    await provider.sendToRecipient('customer', 'booking.confirmed', booking(), config);

    const body = JSON.parse(request.mock.calls[0]![1]!.body as string) as { htmlContent: string };
    expect(body.htmlContent).toContain('Pickup: <strong>Praça do Comércio</strong>');
    expect(body.htmlContent).toContain('<a href="https://maps.google.com/?q=Praca+do+Comercio">Open map</a>');
  });

  it('escapes the manage-link URLs like every other interpolated field', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const provider = brevoEmail({ apiKey: 'key', fetch: request });
    const maliciousConfig: typeof config = {
      ...config,
      business: { ...config.business, url: 'https://example.test/"><script>' },
    };

    await provider.send('booking.confirmed', booking(), maliciousConfig);

    expect(request).toHaveBeenCalledTimes(2);
    const customerHtml = JSON.parse(request.mock.calls[0]![1]!.body as string) as { htmlContent: string };
    const ownerHtml = JSON.parse(request.mock.calls[1]![1]!.body as string) as { htmlContent: string };
    expect(customerHtml.htmlContent).not.toContain('"><script>');
    expect(customerHtml.htmlContent).toContain('&quot;&gt;&lt;script&gt;');
    expect(ownerHtml.htmlContent).not.toContain('"><script>');
    expect(ownerHtml.htmlContent).toContain('&quot;&gt;&lt;script&gt;');
  });
});
