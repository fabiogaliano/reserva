import { cancelBooking, type Booking } from './core/booking';
import { cancellationSideEffectSeeds, dispatchMutation } from './confirmation';
import type { ReservaContext } from './context';
import { nowIso } from './context';

export type ClaimedOperatorCancellationResult =
  | { kind: 'cancelled'; booking: Booking }
  | { kind: 'slot_changed' }
  | { kind: 'invalid_transition' };

// A durable refund decision is not permission to move money. This shared gate first makes the
// cancellation durable, and only returns a booking that is safe for the refund executor to use.
export async function resumeClaimedOperatorCancellation(
  context: ReservaContext,
  booking: Booking,
  operationId: string,
): Promise<ClaimedOperatorCancellationResult> {
  if (booking.status === 'cancelled') return { kind: 'cancelled', booking };
  if (booking.status !== 'confirmed') return { kind: 'invalid_transition' };

  const cancelled = cancelBooking(booking, 'operator', nowIso(context));
  const updated = await context.repo.transitionToCancelled(cancelled.id, {
    expectedStatusIn: ['confirmed'],
    expectedStartsAt: booking.startsAt,
    cancelledAt: cancelled.updatedAt,
    cancelledBy: 'operator',
    updatedAt: cancelled.updatedAt,
    mutationSideEffects: cancellationSideEffectSeeds(context, booking, 'booking.cancelled_by_operator', cancelled.updatedAt),
  });
  if (updated) {
    await dispatchMutation(context, 'booking.cancelled_by_operator', updated);
    return { kind: 'cancelled', booking: updated };
  }

  const fresh = await context.repo.getBookingById(booking.id);
  if (fresh?.status === 'cancelled') return { kind: 'cancelled', booking: fresh };

  // The original request's decision was computed against a stale slot. Removing only its still-
  // requested row preserves the existing HTTP behavior and lets a new operator decision win.
  await context.repo.deleteRefundOperation(operationId);
  if (fresh?.status === 'confirmed' && fresh.startsAt !== booking.startsAt) return { kind: 'slot_changed' };
  return { kind: 'invalid_transition' };
}
