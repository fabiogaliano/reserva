import { describe, expect, it } from 'vitest';
import type { ResolvedClientConfig } from '../src/core/config';
// Imported the same way an external transport author reaches it: the package's own
// @reservajs/astro/email subpath (src/email/index.ts) resolves to this path.
import { renderDefaultEmail, type EmailRenderer, type EmailTemplateContext } from '../src/email';
import { booking, config } from './fixtures';

// Renderer-level tests exercising the public seam directly, distinct from
// tests/providers-email.test.ts's Brevo-transport-level coverage (HTTP posting, address routing,
// error classification).

function context(overrides: Partial<EmailTemplateContext> = {}): EmailTemplateContext {
  return {
    event: 'booking.confirmed',
    booking: booking(),
    config,
    locale: 'en',
    recipient: 'customer',
    customerManageUrl: 'https://example.test/booking/manage?token=cancel-token',
    operatorManageUrl: 'https://example.test/booking/manage?token=operator-token',
    startsAtLocal: '15 Jun 2026, 09:00',
    ...overrides,
  };
}

describe('renderDefaultEmail (@reservajs/astro/email)', () => {
  it('applies emails.branding overrides to the rendered HTML shell', () => {
    const brandedConfig: ResolvedClientConfig = {
      ...config,
      emails: { branding: { headerBackground: '#003366', accentColor: '#ff9900', logoUrl: 'https://example.test/logo.png', logoWidth: 120, logoHeight: 32 } },
    };
    const rendered = renderDefaultEmail(context({ config: brandedConfig }));
    expect(rendered.html).toContain('background-color:#003366');
    expect(rendered.html).toContain('#ff9900');
    expect(rendered.html).toContain('src="https://example.test/logo.png"');
  });

  it('renders the neutral default branding when none is configured', () => {
    const rendered = renderDefaultEmail(context());
    expect(rendered.html).toContain('background-color:#1a1a1a');
    expect(rendered.html).not.toContain('<img');
  });

  it('overrides refund.timing in English via config.emails.messages', () => {
    const overriddenConfig: ResolvedClientConfig = {
      ...config,
      emails: { messages: { en: { 'refund.timing': 'Refunds arrive within 5 business days.' } } },
    };
    const rendered = renderDefaultEmail(context({ event: 'booking.cancelled_by_customer', config: overriddenConfig }));
    expect(rendered.html).toContain('Refunds arrive within 5 business days.');
    expect(rendered.html).not.toContain('Refunds are returned to your original payment method.');
  });

  it('overrides refund.timing in European Portuguese via config.emails.messages', () => {
    const overriddenConfig: ResolvedClientConfig = {
      ...config,
      locales: { supported: ['en', 'pt-PT'], default: 'en' },
      emails: { messages: { 'pt-PT': { 'refund.timing': 'O reembolso chega em 5 dias úteis.' } } },
    };
    const rendered = renderDefaultEmail(context({ event: 'booking.cancelled_by_operator', locale: 'pt-PT', config: overriddenConfig }));
    expect(rendered.html).toContain('O reembolso chega em 5 dias úteis.');
    expect(rendered.html).not.toContain('Os reembolsos são devolvidos ao seu método de pagamento original.');
  });

  it('a full custom renderer replaces the output entirely, never calling renderDefaultEmail', () => {
    const customRenderer: EmailRenderer = (renderContext) => ({
      subject: `Custom: ${renderContext.event}`,
      html: '<p>fully custom</p>',
      text: 'fully custom',
    });
    const rendered = customRenderer(context());
    expect(rendered).toEqual({ subject: 'Custom: booking.confirmed', html: '<p>fully custom</p>', text: 'fully custom' });
  });

  it('a custom renderer can override one event and delegate every other event to renderDefaultEmail', () => {
    const customRenderer: EmailRenderer = (renderContext) => {
      if (renderContext.event === 'booking.no_show') {
        return { subject: 'We missed you', html: '<p>custom no-show copy</p>' };
      }
      return renderDefaultEmail(renderContext);
    };

    const overridden = customRenderer(context({ event: 'booking.no_show' }));
    expect(overridden).toEqual({ subject: 'We missed you', html: '<p>custom no-show copy</p>' });

    const delegated = customRenderer(context({ event: 'booking.confirmed' }));
    expect(delegated).toEqual(renderDefaultEmail(context({ event: 'booking.confirmed' })));
  });
});

describe('calendar attachment', () => {
  it('attaches booking.ics to the customer confirmation only', () => {
    const customer = renderDefaultEmail(context());
    expect(customer.attachments).toHaveLength(1);
    const [file] = customer.attachments!;
    expect(file!.filename).toBe('booking.ics');
    expect(file!.contentType).toMatch(/^text\/calendar/);
    expect(atob(file!.content)).toContain('BEGIN:VCALENDAR');

    // Checkout snapshots a default meeting point even for an address-only option, so the option
    // decides the calendar location, not the snapshot.
    const addressOnly = renderDefaultEmail(context({ booking: booking({ pickupType: 'custom', pickupAddress: 'Hotel Avenida, room 12', meetingPointId: 'default' }) }));
    const addressIcs = atob(addressOnly.attachments![0]!.content);
    expect(addressIcs).toContain('Hotel Avenida');
    expect(addressIcs).not.toContain('Comércio');

    expect(renderDefaultEmail(context({ recipient: 'owner' })).attachments).toBeUndefined();
    expect(renderDefaultEmail(context({ event: 'booking.cancelled_by_customer' })).attachments).toBeUndefined();
  });
});

describe('value.guests', () => {
  const guestsCell = (html: string) => html.slice(html.indexOf('>Guests</td>'), html.indexOf('</tr>', html.indexOf('>Guests</td>')));

  it.each([
    ['customer confirmed', { event: 'booking.confirmed', recipient: 'customer' }],
    ['owner confirmed', { event: 'booking.confirmed', recipient: 'owner' }],
    ['customer reminder', { event: 'booking.reminder', recipient: 'customer' }],
  ] as const)('renders the bare quantity by default in the %s email', (_, overrides) => {
    const rendered = renderDefaultEmail(context({ ...overrides, booking: booking({ quantity: 8 }) }));
    expect(guestsCell(rendered.html)).toBe('>Guests</td><td style="font-weight:600;"><strong>8</strong></td>');
    expect(rendered.text).toContain('Guests: 8\n');
  });

  it.each([
    ['customer confirmed', { event: 'booking.confirmed', recipient: 'customer' }],
    ['owner confirmed', { event: 'booking.confirmed', recipient: 'owner' }],
    ['customer reminder', { event: 'booking.reminder', recipient: 'customer' }],
  ] as const)('renders an override via config.emails.messages in the %s email', (_, overrides) => {
    const overriddenConfig: ResolvedClientConfig = {
      ...config,
      emails: { messages: { en: { 'value.guests': 'Up to {quantity} guests' } } },
    };
    const rendered = renderDefaultEmail(context({ ...overrides, config: overriddenConfig, booking: booking({ quantity: 8 }) }));
    expect(guestsCell(rendered.html)).toContain('<strong>Up to 8 guests</strong>');
    expect(rendered.text).toContain('Guests: Up to 8 guests\n');
  });

  it('escapes the override in the HTML body like every other copy string', () => {
    const overriddenConfig: ResolvedClientConfig = {
      ...config,
      emails: { messages: { en: { 'value.guests': '{quantity} <b>seats</b> & more' } } },
    };
    const rendered = renderDefaultEmail(context({ config: overriddenConfig, booking: booking({ quantity: 8 }) }));
    expect(guestsCell(rendered.html)).toContain('<strong>8 &lt;b&gt;seats&lt;/b&gt; &amp; more</strong>');
    expect(rendered.text).toContain('Guests: 8 <b>seats</b> & more\n');
  });
});
