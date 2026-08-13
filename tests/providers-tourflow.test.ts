import { describe, expect, it, vi } from 'vitest';
import { booking, config } from './fixtures';
import { mapTourflowFeed, mapTourflowBooking, TOURFLOW_AUTHORIZATION_HEADER, TOURFLOW_SOURCE, TourflowResponseError, tourflow } from '../src/providers/tourflow';

describe('Tourflow provider', () => {
  it('maps a booking into the reservation payload without secrets or tokens', () => {
    const payload = mapTourflowBooking('booking.confirmed', booking(), config, 'example-city-tours');
    expect(payload).toEqual(expect.objectContaining({ externalId: 'booking-1', source: TOURFLOW_SOURCE, operatorSlug: 'example-city-tours', reference: 'LVT-2026-001', partySize: 2, priceEurCents: 10000, paymentStatus: 'paid', status: 'confirmed', event: 'booking.confirmed' }));
    expect(payload).not.toHaveProperty('cancelToken');
    expect(payload).not.toHaveProperty('operatorToken');
  });

  // Plan 017 (design decision 4): additive meetingPointId/meetingPointLabel fields on the
  // reservation payload, mapped straight off the booking (no config lookup — the id/label
  // snapshot is what downstream Tourflow consumers see, same as every other booking field here).
  it('maps a chosen meeting point id and label onto the reservation payload', () => {
    const payload = mapTourflowBooking('booking.confirmed', booking({ meetingPointId: 'belem', meetingPointLabel: 'Belém Tower' }), config, 'example-city-tours');
    expect(payload).toEqual(expect.objectContaining({ meetingPointId: 'belem', meetingPointLabel: 'Belém Tower' }));
  });

  it('maps a booking with no meeting point choice to null fields', () => {
    const payload = mapTourflowBooking('booking.confirmed', booking(), config, 'example-city-tours');
    expect(payload).toEqual(expect.objectContaining({ meetingPointId: null, meetingPointLabel: null }));
  });

  // Plan 018 (design decision 8): TourflowReservation.pickupType widened to Booking['pickupType']
  // (plain string) alongside the core type — a tour-declared id that isn't 'default'/'custom' maps
  // through verbatim, no narrowing or special-casing anywhere in this mapper.
  it('maps a non-enum tour-declared pickupType through verbatim', () => {
    const payload = mapTourflowBooking('booking.confirmed', booking({ pickupType: 'custom_dropoff', pickupAddress: 'Hotel Avenida' }), config, 'example-city-tours');
    expect(payload).toEqual(expect.objectContaining({ pickupType: 'custom_dropoff', pickupAddress: 'Hotel Avenida' }));
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

  it('caps a failed response body and exposes its status without retaining the full body', async () => {
    const body = 'y'.repeat(5_000);
    const sink = tourflow({
      webhookUrl: 'https://tourflow.test/api/webhooks/reservations',
      sharedSecret: 'secret',
      fetch: async () => new Response(body, { status: 502 }),
    });
    let caught: unknown;
    try {
      await sink.push('booking.confirmed', booking());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TourflowResponseError);
    if (!(caught instanceof TourflowResponseError)) throw new Error('Tourflow request unexpectedly succeeded');
    expect(caught.status).toBe(502);
    expect(caught.message).toContain('y'.repeat(200));
    expect(caught.message).not.toContain('y'.repeat(201));
    // Plan 016 (design decision 2): a 5xx is transient (retryable) — read structurally, not by
    // parsing the message.
    expect(caught.retryable).toBe(true);
  });

  it('classifies a 4xx Tourflow rejection as permanent (not retryable)', async () => {
    const sink = tourflow({
      webhookUrl: 'https://tourflow.test/api/webhooks/reservations',
      sharedSecret: 'secret',
      fetch: async () => new Response('unauthorized', { status: 401 }),
    });
    let caught: unknown;
    try {
      await sink.push('booking.confirmed', booking());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TourflowResponseError);
    if (!(caught instanceof TourflowResponseError)) throw new Error('Tourflow request unexpectedly succeeded');
    expect(caught.status).toBe(401);
    expect(caught.retryable).toBe(false);
  });
});
