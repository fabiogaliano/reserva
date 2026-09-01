import { describe, expect, it, vi } from 'vitest';
import { config } from './fixtures';
import { resolveRouteConfig } from '../src/routes-manifest';

describe('booking confirmation page', () => {
  it('renders a confirmed booking from the minimized status payload', async () => {
    vi.doMock('virtual:reserva/runtime', () => ({ default: {} }));
    vi.doMock('virtual:reserva/config', () => ({ default: resolveRouteConfig() }));
    const { confirmationPage } = await import('../src/routes/booking-confirmation');

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      {
        status: 'confirmed',
        booking: {
          reference: 'LVT-2026-001',
          serviceSlug: 'vintage',
          start: '2026-06-15T09:00:00.000+01:00',
          end: '2026-06-15T10:00:00.000+01:00',
          quantity: 2,
          priceMinor: 10000,
          currency: 'eur',
          meetingPoint: { label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' },
          locale: 'en',
          metadataRows: [],
        },
      },
      'https://example.test/booking-confirmation?session_id=cs_confirmed',
      null,
    );

    expect(html).toContain('LVT-2026-001');
    expect(html).toContain('2 people');
    expect(html).toContain('€100.00');
    expect(html).toContain('Praça do Comércio');

    vi.doUnmock('virtual:reserva/runtime');
    vi.doUnmock('virtual:reserva/config');
  });

  it('omits the meeting-point fact and calendar location when the payload has no meetingPoint (plan 019 decision 2)', async () => {
    vi.doMock('virtual:reserva/runtime', () => ({ default: {} }));
    vi.doMock('virtual:reserva/config', () => ({ default: resolveRouteConfig() }));
    const { confirmationPage } = await import('../src/routes/booking-confirmation');

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      {
        status: 'confirmed',
        booking: {
          reference: 'LVT-2026-002',
          serviceSlug: 'vintage',
          start: '2026-06-15T09:00:00.000+01:00',
          end: '2026-06-15T10:00:00.000+01:00',
          quantity: 2,
          priceMinor: 21000,
          currency: 'eur',
          // meetingPoint: null for a custom_both-shaped option (requiresAddress,
          // usesMeetingPoint: false) — always present, never a missing key (plan 023).
          meetingPoint: null,
          locale: 'en',
          metadataRows: [],
        },
      },
      'https://example.test/booking-confirmation?session_id=cs_confirmed_both',
      null,
    );

    expect(html).toContain('LVT-2026-002');
    expect(html).toContain('€210.00');
    expect(html).not.toContain('Praça do Comércio');
    expect(html).not.toContain('Meeting point');
    const decodedHtml = html.replace(/&amp;/g, '&');
    expect(decodedHtml).not.toContain(encodeURIComponent('Praça do Comércio'));

    vi.doUnmock('virtual:reserva/runtime');
    vi.doUnmock('virtual:reserva/config');
  });

  it('renders a status-only confirmed page without a blank ticket', async () => {
    vi.doMock('virtual:reserva/runtime', () => ({ default: {} }));
    vi.doMock('virtual:reserva/config', () => ({ default: resolveRouteConfig() }));
    const { confirmationPage } = await import('../src/routes/booking-confirmation');

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      { status: 'confirmed', booking: null },
      'https://example.test/booking-confirmation?session_id=cs_confirmed',
      null,
    );

    expect(html).toContain('Your booking is confirmed. Full details and a link to manage your booking were emailed to you.');
    expect(html).not.toContain('class="bk-ticket"');
    expect(html).not.toContain('bk-ticket-date');

    vi.doUnmock('virtual:reserva/runtime');
    vi.doUnmock('virtual:reserva/config');
  });

  it('renders a cancelled booking as cancelled with a start-over action', async () => {
    vi.doMock('virtual:reserva/runtime', () => ({ default: {} }));
    vi.doMock('virtual:reserva/config', () => ({ default: resolveRouteConfig() }));
    const { confirmationPage } = await import('../src/routes/booking-confirmation');

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      { status: 'cancelled', booking: null },
      'https://example.test/booking-confirmation?session_id=cs_cancelled',
      null,
    );

    expect(html).toContain('Booking cancelled');
    expect(html).toContain('This booking was cancelled and is no longer active.');
    expect(html).toContain('Start a new booking');
    expect(html).toContain('href="https://example.test"');
    expect(html).not.toContain('Booking not found');
    expect(html).not.toContain('We could not find a booking for this link.');

    vi.doUnmock('virtual:reserva/runtime');
    vi.doUnmock('virtual:reserva/config');
  });

  // Plan 024 (design decision 3): the confirmationSummary payload's labeled metadata rows, and the
  // XSS surface — a customer-supplied text field is the first fully attacker-controlled free text
  // to reach this page, so a hostile payload must never reach the DOM unescaped.
  it('renders labeled metadata rows (boolean as the existing yes/no copy pair) and escapes a hostile value', async () => {
    vi.doMock('virtual:reserva/runtime', () => ({ default: {} }));
    vi.doMock('virtual:reserva/config', () => ({ default: resolveRouteConfig() }));
    const { confirmationPage } = await import('../src/routes/booking-confirmation');
    const xssPayload = '<script>window.__xss = true;</script>"><img src=x onerror=alert(1)>';

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      {
        status: 'confirmed',
        booking: {
          reference: 'LVT-2026-003',
          serviceSlug: 'vintage',
          start: '2026-06-15T09:00:00.000+01:00',
          end: '2026-06-15T10:00:00.000+01:00',
          quantity: 2,
          priceMinor: 10000,
          currency: 'eur',
          locale: 'en',
          meetingPoint: null,
          metadataRows: [
            { key: 'dietary_notes', label: 'Dietary notes', value: xssPayload },
            { key: 'vegetarian', label: 'Vegetarian', value: true },
          ],
        },
      },
      'https://example.test/booking-confirmation?session_id=cs_confirmed_metadata',
      null,
    );

    expect(html).toContain('LVT-2026-003');
    expect(html).toContain('Dietary notes');
    expect(html).toContain('Vegetarian');
    expect(html).toContain('<dd>On</dd>');
    expect(html).not.toContain(xssPayload);
    expect(html).toContain('&lt;script&gt;');

    vi.doUnmock('virtual:reserva/runtime');
    vi.doUnmock('virtual:reserva/config');
  });
});
