import type { Booking } from '../core/booking';
import { parseUtcInstant } from '../core/time';
import type { BookkitContext } from '../context';
import { getSecret, nowIso } from '../context';
import { bearerToken, constantTimeEqual, HttpError, json } from '../http';
import { run } from './shared';

export function defaultFeedBooking(booking: Booking): Record<string, unknown> {
  return {
    id: booking.id,
    reference: booking.reference,
    tourSlug: booking.tourSlug,
    people: booking.people,
    pickupType: booking.pickupType,
    pickupAddress: booking.pickupAddress,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    locale: booking.locale,
    priceCents: booking.priceCents,
    status: booking.status,
    cancelledBy: booking.cancelledBy,
    rescheduledFrom: booking.rescheduledFrom,
    updatedAt: booking.updatedAt,
  };
}

export function handleFeed(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const expected = await getSecret(context, 'TOURFLOW_SHARED_SECRET');
    const supplied = bearerToken(request);
    if (!expected || !supplied || !constantTimeEqual(expected, supplied)) throw new HttpError(403, 'forbidden', 'Feed authorization required');
    const since = new URL(request.url).searchParams.get('since');
    if (!since) throw new HttpError(400, 'validation_failed', 'since is required');
    let canonicalSince: string;
    try {
      canonicalSince = parseUtcInstant(since).toISOString();
    } catch {
      throw new HttpError(400, 'validation_failed', 'since must be an ISO 8601 instant with an explicit offset');
    }
    await context.repo.sweepExpiredHolds(nowIso(context));
    const rows = await context.repo.listSince(canonicalSince);
    const bookings = rows.map((booking) => context.providers.ops?.mapBooking?.(booking, context.config) ?? defaultFeedBooking(booking));
    return json({ bookings }, 200, { 'cache-control': 'no-store' });
  });
}
