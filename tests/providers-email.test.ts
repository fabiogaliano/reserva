import { describe, expect, it, vi } from 'vitest';
import { brevoEmail, BREVO_TRANSACTIONAL_EMAIL_URL } from '../src/providers/brevo';
import { calendarInviteOnly } from '../src/providers/noop';
import { booking, config } from './fixtures';

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
});
