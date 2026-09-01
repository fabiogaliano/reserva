import { describe, expect, it, vi } from 'vitest';
import { config } from './fixtures';
import { resolveRouteConfig } from '../src/routes-manifest';

describe('booking confirmation page', () => {
  it('renders a confirmed booking from the minimized status payload', async () => {
    vi.doMock('virtual:bookkit/runtime', () => ({ default: {} }));
    vi.doMock('virtual:bookkit/config', () => ({ default: resolveRouteConfig() }));
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
          meetingPoint: config.services.vintage?.location?.meetingPoints?.[0],
          locale: 'en',
        },
      },
      'https://example.test/booking-confirmation?session_id=cs_confirmed',
      null,
    );

    expect(html).toContain('LVT-2026-001');
    expect(html).toContain('2 people');
    expect(html).toContain('€100.00');
    expect(html).toContain('Praça do Comércio');

    vi.doUnmock('virtual:bookkit/runtime');
    vi.doUnmock('virtual:bookkit/config');
  });

  it('omits the meeting-point fact and calendar location when the payload has no meetingPoint (plan 019 decision 2)', async () => {
    vi.doMock('virtual:bookkit/runtime', () => ({ default: {} }));
    vi.doMock('virtual:bookkit/config', () => ({ default: resolveRouteConfig() }));
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
          // No meetingPoint: confirmationSummary omits it for a custom_both-shaped option
          // (requiresAddress, usesMeetingPoint: false).
          locale: 'en',
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

    vi.doUnmock('virtual:bookkit/runtime');
    vi.doUnmock('virtual:bookkit/config');
  });

  it('renders a status-only confirmed page without a blank ticket', async () => {
    vi.doMock('virtual:bookkit/runtime', () => ({ default: {} }));
    vi.doMock('virtual:bookkit/config', () => ({ default: resolveRouteConfig() }));
    const { confirmationPage } = await import('../src/routes/booking-confirmation');

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      { status: 'confirmed' },
      'https://example.test/booking-confirmation?session_id=cs_confirmed',
      null,
    );

    expect(html).toContain('Your booking is confirmed. Full details and a link to manage your booking were emailed to you.');
    expect(html).not.toContain('class="bk-ticket"');
    expect(html).not.toContain('bk-ticket-date');

    vi.doUnmock('virtual:bookkit/runtime');
    vi.doUnmock('virtual:bookkit/config');
  });

  it('renders a cancelled booking as cancelled with a start-over action', async () => {
    vi.doMock('virtual:bookkit/runtime', () => ({ default: {} }));
    vi.doMock('virtual:bookkit/config', () => ({ default: resolveRouteConfig() }));
    const { confirmationPage } = await import('../src/routes/booking-confirmation');

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      { status: 'cancelled' },
      'https://example.test/booking-confirmation?session_id=cs_cancelled',
      null,
    );

    expect(html).toContain('Booking cancelled');
    expect(html).toContain('This booking was cancelled and is no longer active.');
    expect(html).toContain('Start a new booking');
    expect(html).toContain('href="https://example.test"');
    expect(html).not.toContain('Booking not found');
    expect(html).not.toContain('We could not find a booking for this link.');

    vi.doUnmock('virtual:bookkit/runtime');
    vi.doUnmock('virtual:bookkit/config');
  });
});
