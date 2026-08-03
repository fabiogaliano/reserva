import { describe, expect, it, vi } from 'vitest';
import { BrevoResponseError, brevoEmail, BREVO_TRANSACTIONAL_EMAIL_URL } from '../src/providers/brevo';
import { calendarInviteOnly } from '../src/providers/noop';
import { booking, config } from './fixtures';
import { resolveRouteConfig } from '../src/routes-manifest';

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
