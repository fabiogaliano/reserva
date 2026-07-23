import { describe, expect, it, vi } from 'vitest';
import { config } from './fixtures';
import { resolveRouteConfig } from '../src/routes-manifest';

describe('booking confirmation page', () => {
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
