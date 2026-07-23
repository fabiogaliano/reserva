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
          tourSlug: 'vintage',
          start: '2026-06-15T09:00:00.000+01:00',
          end: '2026-06-15T10:00:00.000+01:00',
          people: 2,
          priceCents: 10000,
          meetingPoint: config.tours.vintage?.meetingPoint,
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
