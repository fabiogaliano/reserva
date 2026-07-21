import { describe, expect, it, vi } from 'vitest';
import { booking, config } from './fixtures';
import { mapTourflowFeed, mapTourflowBooking, TOURFLOW_AUTHORIZATION_HEADER, TOURFLOW_SOURCE, tourflow } from '../src/providers/tourflow';

describe('Tourflow provider', () => {
  it('maps a booking into the reservation payload without secrets or tokens', () => {
    const payload = mapTourflowBooking('booking.confirmed', booking(), config, 'example-city-tours');
    expect(payload).toEqual(expect.objectContaining({ externalId: 'booking-1', source: TOURFLOW_SOURCE, operatorSlug: 'example-city-tours', reference: 'LVT-2026-001', partySize: 2, priceEurCents: 10000, paymentStatus: 'paid', status: 'confirmed', event: 'booking.confirmed' }));
    expect(payload).not.toHaveProperty('cancelToken');
    expect(payload).not.toHaveProperty('operatorToken');
  });

  it('maps the feed and derives cancellation and no-show events', () => {
    const feed = mapTourflowFeed([booking(), booking({ id: 'booking-2', status: 'cancelled', cancelledBy: 'customer' }), booking({ id: 'booking-3', status: 'no_show' })], config);
    expect(feed.bookings.map((entry) => entry.event)).toEqual(['booking.confirmed', 'booking.cancelled_by_customer', 'booking.no_show']);
  });

  it('pushes an authenticated payload through the injected fetch callback', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 202 }));
    const sink = tourflow({ webhookUrl: 'https://tourflow.test/api/webhooks/reservations', sharedSecret: 'secret', fetch: request, operatorSlug: 'lvt' });
    await sink.push('booking.confirmed', booking());
    expect(request).toHaveBeenCalledWith('https://tourflow.test/api/webhooks/reservations', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ [TOURFLOW_AUTHORIZATION_HEADER]: 'Bearer secret' }) }));
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual(expect.objectContaining({ externalId: 'booking-1', operatorSlug: 'lvt' }));
  });
});
